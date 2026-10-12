# Neon Drift: City — multiplayer server

Small Node.js WebSocket server (`ws`) with in-memory rooms for online races in Neon Drift: City.
No database, no accounts. One process holds all rooms, so run a **single instance**.

## Run locally
```bash
npm install
npm start                # ws://localhost:8080, health: http://localhost:8080/health
npm test                 # protocol test (spawns its own server on a random port)
```
Then open the game, e.g. `http://localhost:8820/neon-drift-city/play.html?mp=1`.
The client uses `ws://localhost:8080` by default (`js/net-config.js`). Add `?server=ws://host:port` to override it.

## Environment
| Var | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | HTTP/WebSocket port (Render/Railway/Fly set this for you) |
| `ALLOWED_ORIGINS` | `*` | Comma-separated list of allowed page origins, e.g. `https://neondrift.netlify.app,https://example.com` |
| `MAX_ROOMS` | `500` | |
| `ROOM_IDLE_MS` | `1800000` | Rooms with no messages for this long are closed (30 min) |
| `RECONNECT_MS` | `20000` | A dropped player is kept as a ghost this long and can rejoin with their token |
| `COUNTDOWN_MS` | `4000` | Server-synced countdown before GO |
| `FINISH_GRACE_MS` | `60000` | After the first finisher, the others have this long |
| `MAX_RACE_MS` | `360000` | Race time limit |
| `QUIET` | – | Set to disable logging |

## Endpoints
- `GET /health` → `{"ok":true,"rooms":N,"players":N,"uptime":s}` (CORS headers per `ALLOWED_ORIGINS`)
- WebSocket on any path of the same host (`wss://<host>/`)

## Protocol (JSON, field `t`)
Client → server: `create {name,avatar,vehicle}`, `join {code,name,avatar,vehicle,token?}`, `leave`, `profile`, `ready {ready}`,
`settings {route,laps,ai,gridSize}` (host), `start` (host), `state {p,q,v,st,sp,n,nos,br}` (~15 Hz), `bots {list}` (host, AI cars),
`cp {i,bot?}`, `quit`, `botDnf`, `rematch`, `ping {c}`.
Server → client: `welcome`, `lobby {room}`, `race {route,laps,total,startAt,now,grid,bots}`, `states {list}`, `cp`, `cpReject`,
`finish {id,place,time}`, `results {order}`, `ghost`, `left`, `dnf`, `rematch`, `pong`, `error {code,msg}`.

The server is authoritative for checkpoints and results: a checkpoint is accepted only in sequence, ≥0.8 s after the previous one, and
when the car's last reported position is within 40 m of it. Finish time = server time − `startAt`. Inputs are clamped, names sanitised,
messages are capped at 4 KB, and each socket has a token bucket (40 msg/s, burst 60; flooding closes it with 1008).

## Deploy (not done yet: pick one)
**Render (recommended, free web service).** Push this folder to a GitHub repo, then in Render: *New → Blueprint* (uses `render.yaml`)
or *New → Web Service* with build `npm ci --omit=dev`, start `npm start`, health check `/health`. You get `https://<name>.onrender.com`;
the game connects to `wss://<name>.onrender.com`. Free instances sleep after ~15 min idle, and the first connection then waits
~30–60 s while the server wakes up. The client retries for about 40 s and shows "waking up". In-memory rooms are lost on sleep or redeploy.

**Railway:** New project → Deploy from repo (Dockerfile or Nixpacks detects `npm start`). **Fly.io:** `fly launch --copy-config` then `fly deploy` (uses `Dockerfile` + `fly.toml`).

After deploying: set `PRODUCTION_URL` in `neon-drift-city/js/net-config.js` to the `wss://` URL, set `ALLOWED_ORIGINS` to the game's
site origin, and redeploy the static game.
