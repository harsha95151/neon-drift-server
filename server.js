/* Neon Drift: City — multiplayer room server.
   Plain Node http + ws, in-memory rooms. Host-agnostic: PORT / ALLOWED_ORIGINS from the environment. */
'use strict';
const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { ROUTES, checkpointPos, totalCheckpoints } = require('./routes');

const env = process.env;
const PORT = +env.PORT || 8080;
const ALLOWED = (env.ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim()).filter(Boolean);
const MAX_PLAYERS = 8;
const MAX_ROOMS = +env.MAX_ROOMS || 500;
const ROOM_IDLE_MS = +env.ROOM_IDLE_MS || 30 * 60 * 1000;
const RECONNECT_MS = +env.RECONNECT_MS || 20000;       // a dropped player is kept as a ghost this long
const COUNTDOWN_MS = +env.COUNTDOWN_MS || 4000;
const FINISH_GRACE_MS = +env.FINISH_GRACE_MS || 60000;  // after the first finisher, others get this long
const MAX_RACE_MS = +env.MAX_RACE_MS || 6 * 60 * 1000;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no 0/O/1/I
const AVATARS = ['kaze', 'ryuu', 'hikari', 'jin', 'yuki', 'nova'];
const AVATAR_NAMES = { kaze: 'Kaze', ryuu: 'Ryuu', hikari: 'Hikari', jin: 'Jin', yuki: 'Yuki', nova: 'Nova' };
const VEHICLES = ['kestrel', 'vandal', 'aurora', 'viper'];
const BOT_CARS = ['vandal', 'kestrel', 'aurora'];
const log = (...a) => { if (!env.QUIET) console.log(new Date().toISOString(), ...a); };

/* ---------------- helpers ---------------- */
const rooms = new Map();
const now = () => Date.now();
const num = (v, lo, hi, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const vec = (a, n, lim) => (Array.isArray(a) && a.length === n ? a.map((x) => +num(x, -lim, lim).toFixed(3)) : null);
const cleanName = (s, d) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f<>&"'`]/g, '').trim().slice(0, 16) : '') || d;
const pick = (v, list, d) => (list.includes(v) ? v : d);
function newCode() { for (let k = 0; k < 1000; k++) { let c = ''; for (let i = 0; i < 4; i++) c += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]; if (!rooms.has(c)) return c; } return null; }
function originOk(origin) { if (ALLOWED.includes('*')) return true; return !!origin && ALLOWED.includes(origin); }
function send(ws, msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }

/* ---------------- rooms ---------------- */
function roomView(r) {
  return { code: r.code, host: r.host, state: r.state, settings: r.settings,
    players: [...r.players.values()].map((p) => ({ id: p.id, name: p.name, avatar: p.avatar, vehicle: p.vehicle, ready: p.ready, host: p.id === r.host, connected: !!p.ws, slot: p.slot })) };
}
function broadcast(r, msg, except) { const s = JSON.stringify(msg); for (const p of r.players.values()) if (p.ws && p !== except && p.ws.readyState === 1) p.ws.send(s); }
function lobby(r) { broadcast(r, { t: 'lobby', room: roomView(r) }); }
function touch(r) { r.lastActive = now(); }
function freeSlot(r) { const used = new Set([...r.players.values()].map((p) => p.slot)); for (let s = 0; s < MAX_PLAYERS; s++) if (!used.has(s)) return s; return -1; }
function pickHost(r) {
  const cur = r.players.get(r.host); if (cur && cur.ws) return;
  const next = [...r.players.values()].filter((p) => p.ws).sort((a, b) => a.joinedAt - b.joinedAt)[0];
  if (next) { r.host = next.id; log('room', r.code, 'host ->', next.name); }
}
function removePlayer(r, p, why) {
  r.players.delete(p.id);
  if (r.race) { const e = r.race.racers.get(p.id); if (e && !e.finished) { e.dnf = true; e.left = true; } }
  log('room', r.code, 'player', p.name, 'removed:', why);
  if (![...r.players.values()].some((x) => x.ws)) { closeRoom(r, 'empty'); return; }
  pickHost(r); broadcast(r, { t: 'left', id: p.id, why }); lobby(r); checkRaceOver(r);
}
function closeRoom(r, why) {
  if (!rooms.has(r.code)) return;
  clearTimeout(r.race && r.race.timer);
  for (const p of r.players.values()) { clearTimeout(p.dropTimer); if (p.ws) { send(p.ws, { t: 'error', code: 'room_closed', msg: 'Room closed (' + why + ')' }); p.ws.room = null; } }
  rooms.delete(r.code); log('room', r.code, 'closed:', why);
}

/* ---------------- race ---------------- */
function startRace(r) {
  const s = r.settings, route = ROUTES[s.route];
  const racers = new Map(), grid = [];
  const humans = [...r.players.values()].filter((p) => p.ws).sort((a, b) => a.slot - b.slot);
  humans.forEach((p, k) => { racers.set(p.id, { id: p.id, name: p.name, avatar: p.avatar, vehicle: p.vehicle, bot: false, cp: 0, lap: 0, lastCpAt: 0, finished: false, time: null, dnf: false }); grid.push({ id: p.id, slot: k }); });
  const bots = [];
  if (s.ai) {
    const used = new Set(humans.map((p) => p.avatar)); const free = AVATARS.filter((a) => !used.has(a));
    for (let k = humans.length, b = 0; k < s.gridSize; k++, b++) {
      const av = free[b % Math.max(1, free.length)] || AVATARS[b % AVATARS.length];
      const bot = { id: 'bot' + (b + 1), name: AVATAR_NAMES[av] + ' (AI)', avatar: av, vehicle: BOT_CARS[b % BOT_CARS.length], bot: true, cp: 0, lap: 0, lastCpAt: 0, finished: false, time: null, dnf: false };
      racers.set(bot.id, bot); bots.push({ id: bot.id, name: bot.name, avatar: bot.avatar, vehicle: bot.vehicle, slot: k }); grid.push({ id: bot.id, slot: k });
    }
  }
  const startAt = now() + COUNTDOWN_MS;
  r.race = { route: s.route, laps: s.laps, total: totalCheckpoints(route, s.laps), startAt, racers, finishers: 0, firstFinishAt: 0, timer: null, n: (r.raceN = (r.raceN || 0) + 1) };
  r.state = 'racing';
  r.race.timer = setTimeout(() => endRace(r, 'time limit'), COUNTDOWN_MS + MAX_RACE_MS);
  broadcast(r, { t: 'race', route: s.route, laps: s.laps, total: r.race.total, startAt, now: now(), grid, bots, race: r.race.n });
  lobby(r);
  log('room', r.code, 'race', r.race.n, 'start', s.route, 'laps', s.laps, 'racers', racers.size);
}
function onCheckpoint(r, racer, i, pos) {
  const R = r.race, t = now();
  if (!R || racer.finished || racer.dnf || t < R.startAt) return false;
  if (i !== racer.cp + 1 || i > R.total) return false;
  if (t - racer.lastCpAt < 800) return false;   // too fast to be real
  if (pos) { const c = checkpointPos(ROUTES[R.route], i); if (Math.hypot(c[0] - pos[0], c[1] - pos[2]) > 40) return false; }
  racer.cp = i; racer.lastCpAt = t; racer.lap = Math.floor((i - 1) / (ROUTES[R.route].pts.length - 1));
  broadcast(r, { t: 'cp', id: racer.id, i, lap: racer.lap, time: t - R.startAt });
  if (i === R.total) {
    racer.finished = true; racer.time = t - R.startAt; racer.place = ++R.finishers;
    broadcast(r, { t: 'finish', id: racer.id, place: racer.place, time: racer.time });
    log('room', r.code, 'finish', racer.place, racer.name, (racer.time / 1000).toFixed(2) + 's');
    if (!R.firstFinishAt) { R.firstFinishAt = t; clearTimeout(R.timer); R.timer = setTimeout(() => endRace(r, 'grace over'), FINISH_GRACE_MS); }
  }
  checkRaceOver(r); return true;
}
function checkRaceOver(r) {
  const R = r.race; if (!R || r.state !== 'racing') return;
  const humansLeft = [...R.racers.values()].some((e) => !e.bot && !e.finished && !e.dnf);
  const botsLeft = [...R.racers.values()].some((e) => e.bot && !e.finished && !e.dnf);
  if (!humansLeft && (!botsLeft || ![...r.players.values()].some((p) => p.ws))) endRace(r, 'all finished');
  else if (!humansLeft && botsLeft && !R.botWait) { R.botWait = true; clearTimeout(R.timer); R.timer = setTimeout(() => endRace(r, 'bots timeout'), +env.BOT_WAIT_MS || 10000); }
}
function endRace(r, why) {
  const R = r.race; if (!R || r.state !== 'racing') return;
  clearTimeout(R.timer);
  const all = [...R.racers.values()];
  const fin = all.filter((e) => e.finished).sort((a, b) => a.time - b.time);
  const rest = all.filter((e) => !e.finished).sort((a, b) => b.cp - a.cp);
  const order = [...fin, ...rest].map((e, k) => ({ id: e.id, name: e.name, avatar: e.avatar, vehicle: e.vehicle, bot: e.bot, place: k + 1, time: e.finished ? e.time : null, dnf: !e.finished, cp: e.cp }));
  r.state = 'results'; r.results = { order, route: R.route, laps: R.laps, race: R.n };
  for (const p of r.players.values()) p.ready = false;
  broadcast(r, Object.assign({ t: 'results' }, r.results)); lobby(r);
  log('room', r.code, 'results (' + why + '):', order.map((o) => o.place + '.' + o.name + (o.dnf ? '(DNF)' : '')).join(' '));
}

/* ---------------- message handling ---------------- */
function profile(p, m) {
  if ('name' in m) p.name = cleanName(m.name, p.name || 'Racer');
  if ('avatar' in m) p.avatar = pick(m.avatar, AVATARS, p.avatar || 'kaze');
  if ('vehicle' in m) p.vehicle = pick(m.vehicle, VEHICLES, p.vehicle || 'vandal');
}
function joinRoom(ws, r, m) {
  // reconnect with a token -> reclaim the old slot
  const tok = typeof m.token === 'string' ? m.token.slice(0, 64) : null;
  let p = tok && [...r.players.values()].find((x) => x.token === tok);
  if (p) { if (p.ws && p.ws !== ws) { p.ws.room = null; p.ws.close(4000, 'replaced'); } clearTimeout(p.dropTimer); p.ws = ws; }
  else {
    if (r.players.size >= MAX_PLAYERS) return send(ws, { t: 'error', code: 'room_full', msg: 'That room is full (8 players).' });
    if (r.state !== 'lobby' && r.state !== 'results') return send(ws, { t: 'error', code: 'in_race', msg: 'A race is in progress in that room. Try again when it finishes.' });
    p = { id: crypto.randomBytes(4).toString('hex'), token: crypto.randomBytes(12).toString('hex'), ws, ready: false, slot: freeSlot(r), joinedAt: now(), name: 'Racer', avatar: 'kaze', vehicle: 'vandal' };
    profile(p, m); r.players.set(p.id, p);
  }
  ws.room = r; ws.player = p; touch(r); pickHost(r);
  send(ws, { t: 'welcome', id: p.id, token: p.token, code: r.code, now: now(), room: roomView(r) });
  if (r.state === 'racing' && r.race) {   // rejoined mid-race: resend race info
    const grid = [...r.race.racers.values()].map((e, k) => ({ id: e.id, slot: k }));
    const bots = [...r.race.racers.values()].filter((e) => e.bot).map((e, k) => ({ id: e.id, name: e.name, avatar: e.avatar, vehicle: e.vehicle }));
    const me = r.race.racers.get(p.id);
    send(ws, { t: 'race', route: r.race.route, laps: r.race.laps, total: r.race.total, startAt: r.race.startAt, now: now(), grid, bots, race: r.race.n, rejoin: true, cp: me ? me.cp : 0 });
  } else if (r.state === 'results') send(ws, Object.assign({ t: 'results' }, r.results));
  lobby(r);
  log('room', r.code, 'join', p.name, '(' + r.players.size + ' players)');
}
function handle(ws, m) {
  const t = m.t, r = ws.room, p = ws.player;
  if (t === 'ping') return send(ws, { t: 'pong', c: num(m.c, 0, 1e15), s: now() });
  if (t === 'create') {
    if (r) return send(ws, { t: 'error', code: 'already_in_room', msg: 'Leave your current room first.' });
    if (rooms.size >= MAX_ROOMS) return send(ws, { t: 'error', code: 'server_full', msg: 'The server is full right now.' });
    const code = newCode(); if (!code) return send(ws, { t: 'error', code: 'server_full', msg: 'No free room codes.' });
    const room = { code, host: null, state: 'lobby', players: new Map(), settings: { route: 'downtown', laps: 1, ai: true, gridSize: 4 }, createdAt: now(), lastActive: now(), race: null };
    rooms.set(code, room); log('room', code, 'created');
    return joinRoom(ws, room, m);
  }
  if (t === 'join') {
    const code = typeof m.code === 'string' ? m.code.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4) : '';
    const room = rooms.get(code);
    if (!room) return send(ws, { t: 'error', code: 'no_room', msg: `Room ${code || '?'} doesn't exist (or it expired).` });
    if (r && r !== room) leave(ws, 'switched room');
    return joinRoom(ws, room, m);
  }
  if (!r || !p) return send(ws, { t: 'error', code: 'not_in_room', msg: 'Not in a room.' });
  touch(r);
  const isHost = r.host === p.id;
  switch (t) {
    case 'leave': return leave(ws, 'left');
    case 'profile': profile(p, m); return lobby(r);
    case 'ready': if (r.state === 'lobby' || r.state === 'results') { p.ready = !!m.ready; lobby(r); } return;
    case 'settings':
      if (!isHost || r.state === 'racing') return;
      if (m.route in ROUTES) r.settings.route = m.route;
      if ('laps' in m) r.settings.laps = Math.round(num(m.laps, 1, 3, 1));
      if ('ai' in m) r.settings.ai = !!m.ai;
      if ('gridSize' in m) r.settings.gridSize = Math.round(num(m.gridSize, 2, MAX_PLAYERS, 4));
      return lobby(r);
    case 'start': {
      if (!isHost) return send(ws, { t: 'error', code: 'not_host', msg: 'Only the host can start the race.' });
      if (r.state === 'racing') return;
      const notReady = [...r.players.values()].filter((x) => x.ws && x.id !== r.host && !x.ready);
      if (notReady.length) return send(ws, { t: 'error', code: 'not_ready', msg: 'Waiting for: ' + notReady.map((x) => x.name).join(', ') });
      return startRace(r);
    }
    case 'state': case 'bots': {
      if (r.state !== 'racing' || !r.race) return;
      const tt = now();
      const k = t === 'state' ? 'lastState' : 'lastBots';   // separate budgets for own car and (host) bot cars
      if (tt - (ws[k] || 0) < 35) return;   // >~28 Hz: drop silently
      ws[k] = tt;
      const list = t === 'state' ? [Object.assign({}, m, { id: p.id })] : (isHost && Array.isArray(m.list) ? m.list.slice(0, MAX_PLAYERS) : []);
      const out = [];
      for (const s of list) {
        const e = r.race.racers.get(s.id); if (!e || (e.bot !== (t === 'bots'))) continue;
        const pos = vec(s.p, 3, 2000), q = vec(s.q, 4, 1.001), v = vec(s.v, 3, 150); if (!pos || !q) continue;
        e.pos = pos; e.posAt = tt;
        out.push({ id: s.id, ts: tt, p: pos, q, v: v || [0, 0, 0], st: +num(s.st, -1, 1).toFixed(2), sp: +num(s.sp, 0, 150).toFixed(1), n: +num(s.n, 0, 1).toFixed(2), nos: !!s.nos, br: !!s.br, cp: e.cp, lap: e.lap });
      }
      if (out.length) broadcast(r, { t: 'states', list: out }, p);
      return;
    }
    case 'cp': {
      if (!r.race) return;
      const id = m.bot ? String(m.bot) : p.id; const e = r.race.racers.get(id);
      if (!e || (m.bot && (!e.bot || !isHost))) return;
      const ok = onCheckpoint(r, e, Math.round(num(m.i, 0, 999)), e.posAt && now() - e.posAt < 2000 ? e.pos : null);
      if (!ok) send(ws, { t: 'cpReject', id, i: m.i, cp: e.cp });
      return;
    }
    case 'quit': {   // gave up the race but stays in the room
      if (r.race && r.state === 'racing') { const e = r.race.racers.get(p.id); if (e && !e.finished) { e.dnf = true; broadcast(r, { t: 'dnf', id: p.id }); checkRaceOver(r); } }
      return;
    }
    case 'botDnf': {
      if (isHost && r.race) { const e = r.race.racers.get(String(m.bot)); if (e && e.bot && !e.finished) { e.dnf = true; checkRaceOver(r); } }
      return;
    }
    case 'rematch':
      if (r.state === 'results') { r.state = 'lobby'; r.race = null; for (const x of r.players.values()) x.ready = false; broadcast(r, { t: 'rematch', by: p.id }); lobby(r); }
      return;
    default: return send(ws, { t: 'error', code: 'bad_type', msg: 'Unknown message' });
  }
}
function leave(ws, why) {
  const r = ws.room, p = ws.player; ws.room = null; ws.player = null;
  if (!r || !p || !rooms.has(r.code)) return;
  clearTimeout(p.dropTimer); p.ws = null; removePlayer(r, p, why);
}
function onClose(ws) {
  const r = ws.room, p = ws.player; if (!r || !p || p.ws !== ws) return;
  p.ws = null; ws.room = null;
  log('room', r.code, 'disconnect', p.name);
  if (![...r.players.values()].some((x) => x.ws)) {   // nobody left online: keep the room briefly for reconnects
    p.dropTimer = setTimeout(() => { if (rooms.has(r.code) && ![...r.players.values()].some((x) => x.ws)) closeRoom(r, 'empty'); }, RECONNECT_MS);
    return;
  }
  pickHost(r);
  broadcast(r, { t: 'ghost', id: p.id, ms: RECONNECT_MS }); lobby(r);
  p.dropTimer = setTimeout(() => { if (!p.ws && r.players.get(p.id) === p) removePlayer(r, p, 'disconnected'); }, RECONNECT_MS);
}

/* ---------------- http + ws ---------------- */
function cors(req, res) {
  const o = req.headers.origin;
  if (ALLOWED.includes('*')) res.setHeader('Access-Control-Allow-Origin', '*');
  else if (o && ALLOWED.includes(o)) { res.setHeader('Access-Control-Allow-Origin', o); res.setHeader('Vary', 'Origin'); }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
}
const server = http.createServer((req, res) => {
  cors(req, res);
  const url = (req.url || '/').split('?')[0];
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (url === '/health' || url === '/healthz') {
    let players = 0; for (const r of rooms.values()) for (const p of r.players.values()) if (p.ws) players++;
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ ok: true, rooms: rooms.size, players, uptime: Math.round(process.uptime()) }));
  }
  if (url === '/') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('Neon Drift multiplayer server. WebSocket endpoint: this URL (ws:// or wss://). Health: /health\n'); }
  res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found\n');
});
const wss = new WebSocketServer({ noServer: true, maxPayload: 4096, perMessageDeflate: false });
server.on('upgrade', (req, sock, head) => {
  if (!originOk(req.headers.origin)) { sock.write('HTTP/1.1 403 Forbidden\r\n\r\n'); sock.destroy(); log('rejected origin', req.headers.origin); return; }
  wss.handleUpgrade(req, sock, head, (ws) => wss.emit('connection', ws, req));
});
wss.on('connection', (ws) => {
  ws.alive = true; ws.tokens = 60; ws.tokT = now(); ws.drops = 0;
  ws.on('pong', () => (ws.alive = true));
  ws.on('message', (data, isBinary) => {
    // token bucket: 60 burst, 40 msg/s sustained; persistent flooding closes the socket
    const t = now(); ws.tokens = Math.min(60, ws.tokens + (t - ws.tokT) * 0.04); ws.tokT = t;
    if (ws.tokens < 1) { if (++ws.drops > 200) ws.close(1008, 'rate limit'); return; }
    ws.tokens -= 1;
    if (isBinary) return;
    let m; try { m = JSON.parse(data.toString()); } catch (e) { return send(ws, { t: 'error', code: 'bad_json', msg: 'Bad message' }); }
    if (!m || typeof m !== 'object' || typeof m.t !== 'string') return;
    try { handle(ws, m); } catch (e) { log('handler error', e && e.stack); }
  });
  ws.on('close', () => onClose(ws));
  ws.on('error', () => {});
});
// heartbeat + idle sweep
const hb = setInterval(() => {
  for (const ws of wss.clients) { if (!ws.alive) { ws.terminate(); continue; } ws.alive = false; try { ws.ping(); } catch (e) {} }
  const t = now();
  for (const r of rooms.values()) if (t - r.lastActive > ROOM_IDLE_MS) closeRoom(r, 'idle');
}, +env.SWEEP_MS || 30000);
hb.unref();
server.listen(PORT, () => log(`neon-drift-server listening on :${PORT} (origins: ${ALLOWED.join(',')})`));
function shutdown() { log('shutting down'); for (const r of [...rooms.values()]) closeRoom(r, 'server restart'); server.close(); setTimeout(() => process.exit(0), 300).unref(); }
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
module.exports = { server, rooms };
