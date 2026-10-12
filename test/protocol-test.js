/* Protocol test: spawns the server on a free port and drives it with ws clients. node test/protocol-test.js */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');
const { ROUTES, checkpointPos, totalCheckpoints } = require('../routes');
const PORT = 18000 + Math.floor(Math.random() * 1000);
const URL = 'ws://127.0.0.1:' + PORT;
let fails = 0, passes = 0;
const ok = (c, msg) => { if (c) { passes++; console.log('  ok  ', msg); } else { fails++; console.log('  FAIL', msg); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function client(origin = 'http://localhost:8820') {
  return new Promise((res, rej) => {
    const ws = new WebSocket(URL, { origin }); const c = { ws, msgs: [], waiters: [] };
    ws.on('message', (d) => { const m = JSON.parse(d); c.msgs.push(m); c.waiters = c.waiters.filter((w) => !(w.f(m) && (w.r(m), true))); });
    ws.on('open', () => res(c)); ws.on('error', rej); ws.on('unexpected-response', (q, r) => rej(new Error('HTTP ' + r.statusCode)));
    c.send = (m) => ws.send(JSON.stringify(m));
    c.wait = (f, ms = 3000) => new Promise((r, j) => { const hit = c.msgs.find(f); if (hit) { c.msgs.splice(c.msgs.indexOf(hit), 1); return r(hit); } const w = { f, r: (m) => { c.msgs.splice(c.msgs.indexOf(m), 1); r(m); } }; c.waiters.push(w); setTimeout(() => j(new Error('timeout waiting')), ms); });
    c.type = (t, ms) => c.wait((m) => m.t === t, ms);
  });
}
const get = (p) => new Promise((r, j) => http.get('http://127.0.0.1:' + PORT + p, (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => r({ status: res.statusCode, body: b, headers: res.headers })); }).on('error', j));
(async () => {
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: Object.assign({}, process.env, { PORT, QUIET: '1', COUNTDOWN_MS: '300', RECONNECT_MS: '600', FINISH_GRACE_MS: '3000', BOT_WAIT_MS: '400', ALLOWED_ORIGINS: 'http://localhost:8820,http://127.0.0.1:8820' }), stdio: 'inherit' });
  try {
    for (let k = 0; k < 40; k++) { try { const h = await get('/health'); if (h.status === 200) break; } catch (e) {} await sleep(100); }
    console.log('health / http');
    const h = await get('/health'); ok(h.status === 200 && JSON.parse(h.body).ok === true, '/health 200 ' + h.body);
    ok((await get('/nope')).status === 404, '404 for unknown path');
    console.log('origin allowlist');
    let rejected = false; try { await client('https://evil.example'); } catch (e) { rejected = /403/.test(e.message); } ok(rejected, 'disallowed origin rejected with 403');
    console.log('create / join');
    const A = await client(), B = await client(), C = await client();
    A.send({ t: 'create', name: 'Alice<script>', avatar: 'kaze', vehicle: 'aurora' });
    const wa = await A.type('welcome'); const code = wa.code;
    ok(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/.test(code), 'room code ' + code + ' (4 chars, no 0/O/1/I)');
    ok(wa.room.players[0].name === 'Alicescript' && wa.room.host === wa.id, 'name sanitised, creator is host');
    B.send({ t: 'join', code: code.toLowerCase(), name: 'Bob', avatar: 'ryuu', vehicle: 'tank' });
    const wb = await B.type('welcome'); ok(wb.room.players.length === 2, 'join by code (case-insensitive)');
    ok(wb.room.players.find((p) => p.id === wb.id).vehicle === 'vandal', 'invalid vehicle id clamped to default');
    C.send({ t: 'join', code: 'ZZZZ', name: 'Cy' }); const e1 = await C.type('error'); ok(e1.code === 'no_room', 'unknown code -> no_room error');
    C.send({ t: 'join', code, name: 'Cy', avatar: 'jin', vehicle: 'viper' }); const wc = await C.type('welcome'); ok(wc.room.players.length === 3, 'third player joined');
    console.log('lobby / host controls');
    B.send({ t: 'settings', route: 'harbor' }); await sleep(100);
    A.msgs.length = 0; A.send({ t: 'settings', route: 'downtown', laps: 9, ai: true, gridSize: 5 });
    const lb = await A.wait((m) => m.t === 'lobby' && m.room.settings.gridSize === 5);
    ok(lb.room.settings.route === 'downtown' && lb.room.settings.laps === 3, 'host settings applied, laps clamped to 3, non-host ignored');
    A.send({ t: 'settings', laps: 1 });
    A.send({ t: 'start' }); const e2 = await A.type('error'); ok(e2.code === 'not_ready', 'start blocked until all ready: ' + e2.msg);
    B.send({ t: 'start' }); const e3 = await B.type('error'); ok(e3.code === 'not_host', 'non-host cannot start');
    B.send({ t: 'ready', ready: true }); C.send({ t: 'ready', ready: true }); await sleep(100);
    console.log('race');
    A.send({ t: 'start' });
    const [ra, rb] = await Promise.all([A.type('race'), B.type('race'), C.type('race')]);
    ok(ra.route === 'downtown' && ra.bots.length === 2 && ra.grid.length === 5, 'race start: 3 humans + 2 AI bots on the grid');
    ok(ra.startAt > ra.now && ra.startAt - ra.now <= 400, 'server-synced countdown (startAt in the future)');
    // state relay + clamping
    A.send({ t: 'state', p: [1, 2, 3], q: [0, 0, 0, 1], v: [999, 0, 0], st: 5, sp: 20, n: 0.5, cp: 99 });
    const sb = await B.wait((m) => m.t === 'states');
    ok(sb.list[0].id === wa.id && sb.list[0].v[0] === 150 && sb.list[0].st === 1 && sb.list[0].cp === 0, 'state relayed to others; velocity/steer clamped; cp is server-side');
    A.send({ t: 'state', p: ['x', 2, 3], q: [0, 0, 0, 1] }); await sleep(60);
    B.send({ t: 'bots', list: [{ id: 'bot1', p: [0, 0, 0], q: [0, 0, 0, 1] }] });
    await sleep(150); ok(!C.msgs.some((m) => m.t === 'states' && m.list.some((s) => s.id === 'bot1')), 'non-host cannot drive bots; malformed state dropped');
    await sleep(250);  // past startAt
    const route = ROUTES.downtown, total = totalCheckpoints(route, 1);
    const drive = async (c, i, bot) => { const pos = checkpointPos(route, i); c.send(bot ? { t: 'bots', list: [{ id: bot, p: [pos[0], 0.6, pos[1]], q: [0, 0, 0, 1] }] } : { t: 'state', p: [pos[0], 0.6, pos[1]], q: [0, 0, 0, 1] }); await sleep(40); c.send({ t: 'cp', i, bot }); };
    // checkpoint far from the car is rejected
    B.send({ t: 'state', p: [9999 / 10, 0, 0], q: [0, 0, 0, 1] }); await sleep(40); B.send({ t: 'cp', i: 1 });
    const rej = await B.type('cpReject'); ok(rej.cp === 0, 'checkpoint rejected when the car is nowhere near it');
    B.send({ t: 'cp', i: 3 }); ok((await B.type('cpReject')).cp === 0, 'skipping checkpoints rejected');
    // finishing order: C, then A, then B
    for (let i = 1; i <= total; i++) { await drive(C, i); await drive(A, i); await drive(B, i); await drive(A, i, 'bot1'); await sleep(800); }
    const fins = []; for (let k = 0; k < 4; k++) fins.push(await A.wait((m) => m.t === 'finish', 4000));
    ok(fins.map((f) => f.id).join() === [wc.id, wa.id, wb.id, 'bot1'].join(), 'finish order = order of the final checkpoint (C, A, B, bot1)');
    ok(fins[0].time < fins[1].time && fins[0].place === 1, 'server finish times ascending: ' + fins.map((f) => (f.time / 1000).toFixed(2)).join(', '));
    const res = await B.type('results', 4000);
    ok(res.order.length === 5 && res.order[4].id === 'bot2' && res.order[4].dnf, 'results broadcast; unfinished bot2 = DNF last');
    console.log('rematch');
    C.send({ t: 'rematch' }); await B.type('rematch'); const lb2 = await B.wait((m) => m.t === 'lobby' && m.room.state === 'lobby');
    ok(lb2.room.players.every((p) => !p.ready), 'rematch -> back to lobby, ready flags reset');
    console.log('disconnect / reconnect / host migration');
    A.ws.close(); const g = await B.type('ghost'); ok(g.id === wa.id, 'dropped player broadcast as ghost');
    const lb3 = await B.wait((m) => m.t === 'lobby' && m.room.host !== wa.id); ok(lb3.room.host === wb.id, 'host migrated to next player');
    const A2 = await client(); A2.send({ t: 'join', code, token: wa.token }); const wa2 = await A2.type('welcome');
    ok(wa2.id === wa.id && wa2.room.players.length === 3, 'reconnect with token reclaims the same player');
    C.ws.close(); const left = await B.type('left', 3000); ok(left.id === wc.id, 'ghost removed after the reconnect window');
    console.log('limits');
    const extra = []; for (let k = 0; k < 6; k++) { const x = await client(); x.send({ t: 'join', code, name: 'X' + k }); extra.push(x); }
    await Promise.all(extra.map((x) => x.type('welcome')));
    const F = await client(); F.send({ t: 'join', code, name: 'Nine' }); ok((await F.type('error')).code === 'room_full', '9th player -> room_full');
    const flood = await client(); let closed = false; flood.ws.on('close', (c) => (closed = c === 1008));
    for (let k = 0; k < 400; k++) flood.send({ t: 'ping', c: k });
    await sleep(300); const pongs = flood.msgs.filter((m) => m.t === 'pong').length;
    ok(pongs <= 70 && closed, `rate limit: ${pongs}/400 pings answered, flooder closed (1008)`);
    for (const x of [A2, B, ...extra, F]) x.ws.close();
    await sleep(900); const h2 = JSON.parse((await get('/health')).body); ok(h2.rooms === 0, 'empty room cleaned up (rooms=' + h2.rooms + ')');
  } catch (e) { fails++; console.log('  FAIL exception', e.stack); }
  srv.kill('SIGTERM');
  console.log(`\n${passes} passed, ${fails} failed`); process.exit(fails ? 1 : 0);
})();
