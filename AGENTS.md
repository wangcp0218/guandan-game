# OOWSP — 掼蛋在线对战游戏

npm workspaces monorepo: `client/` (React+Vite), `server/` (Express+Socket.IO), `shared/` (types).

## Commands

```bash
npm install                    # root installs all workspaces
npm run build -w server        # tsc → dist/server/src/
npm run build -w client        # tsc + vite build → client/dist/
npm run dev -w server          # tsx watch (hot-reload, port 3000)
npm run dev -w client          # vite dev server (port 5173, proxies /socket.io to :3000)
```

Build both before deploy: server first, then client.

## Architecture

### Type sharing gotcha

`shared/types.ts` is the source of truth. The **server** tsc compiles it directly (`rootDir: ".."`, so shared/ is in scope). The **client** uses a **local copy** at `client/src/sharedTypes.ts` because Vite/Rollup cannot resolve cross-workspace TypeScript enums. **When changing shared types, update both files.**

### Server output path

`tsconfig.json` has `rootDir: ".."`, so compiled output mirrors the source tree:
- Entry point: `dist/server/src/index.js` (NOT `dist/index.js`)
- shared types: `dist/shared/types.js`
- Data files: `process.cwd()/data/users.json` (persists across redeploys)

### Data storage

Uses JSON files at `data/users.json` and `data/records.json` (no native modules — `better-sqlite3` is incompatible with Node 26). `process.cwd()` must match the systemd `WorkingDirectory=/home/fes/oowsp`.

### Game engine files

| File | Role |
|---|---|
| `server/src/engine/card.ts` | Card creation, deck, sorting, effectiveRank |
| `server/src/engine/patterns.ts` | 18 pattern types, identification, 逢人配(wild card) substitution |
| `server/src/engine/compare.ts` | Pattern comparison, bomb ranking |
| `server/src/engine/rules.ts` | Level system, tribute, partner logic |
| `server/src/engine/ai.ts` | `findBestPlay` (sync rules, default path), `findSmartPlay` (async LLM, opt-in per room) |
| `server/src/engine/llmAi.ts` | DeepSeek API integration, only used when the room opts into `aiUseLLM` |

### AI flow (critical)

`findBestPlay` is the sync rule-based AI and the **default path** in `GameRoom.aiPlay()` (`aiUseLLM === false`): instant, deterministic, no external dependency. `findSmartPlay` (async; DeepSeek via `llmAi.ts`) runs only for rooms created with the 智能 AI toggle (`aiUseLLM === true`); it gates itself further by skipping the simulation budget and model for trivial decisions (≤4 legal plays). AI turns do **not** schedule the 30s forced timeout (see `startTurn`), so a slow LLM response can never force the AI to pass and lose its trick.

### GameRoom turn flow (where bugs hide)

```
startTurn → (AI: setTimeout 500ms → aiPlay → findBestPlay | findSmartPlay → playCards)
           → (human: wait 30s timeout)

playCards → advanceTurn → broadcastState → startTurn()  ← MUST call startTurn!
handlePass → advanceTurn → broadcastState → startTurn()  ← MUST call startTurn!
```

**Both `playCards` and `handlePass` must call `startTurn()` after advancing the turn.** Missing this call was the root cause of AI not playing — the next player's timer was never started.

### Room creation flow

1. `create_room` → room created with aiCount, no players added yet
2. Client navigates, fires `join_room` → player added → `room.fillWithAI()` adds AI players → `canStart()` → `startGame()`

### Player seating

```
        [队友] top (mySeat+2)
   left (mySeat+3)    right (mySeat+1)
        你 bottom (mySeat)
```

Partner = opposite seat, always `(mySeat+2)%4`.

## Deployment

Target server: `fes@192.168.150.34`, password `Fes.123$`.

**Do NOT cross-compile locally** (local arm64, server x86_64). Transfer source, build on server:

```bash
# Build locally (type-check first)
npm run build -w server && npm run build -w client

# Package & transfer source
tar czf /tmp/oowsp-src.tar.gz --exclude='node_modules' --exclude='dist' --exclude='.git' --exclude='.env' . 
sshpass -p 'Fes.123$' scp /tmp/oowsp-src.tar.gz fes@192.168.150.34:/home/fes/oowsp-src.tar.gz

# Build & restart on server
ssh fes@192.168.150.34 "
  cd /home/fes/oowsp && tar xzf /home/fes/oowsp-src.tar.gz && rm /home/fes/oowsp-src.tar.gz
  npm install && npm run build -w server && npm run build -w client
  echo 'Fes.123$' | sudo -S systemctl restart oowsp
"
```

Client-only hotfix: upload `client/dist/assets/index-*.js` and `client/dist/index.html`, clean old JS files from server.

Service management: `systemctl status/restart oowsp` (via sudo). Nginx config at `/etc/nginx/sites-available/oowsp`.

## Environment

`.env` contains `DEEPSEEK_API_KEY`. Not committed to git. On the server, set via systemd `Environment=` in the oowsp service file.

## Gotchas

- **Don't use `better-sqlite3`** — native module breaks on Node 26 arm64 compile
- PM2 was previously installed and may auto-manage the process. Check with `pm2 list` if systemd restart fails with EADDRINUSE
- Client hard-refresh needed after deploy (`Cmd+Shift+R`) — Vite content-hashed filenames help but HTML may be cached
- `broadcastState` is **public** (needed by socketHandlers for rejoin support)
- TURN_TIMEOUT = 30000 (30 seconds)
