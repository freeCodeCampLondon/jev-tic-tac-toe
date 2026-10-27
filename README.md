# Jev Tic-Tac-Toe

A classroom app that teaches **Jev** — TypeSafe AI's "System One" decision model — by playing tic-tac-toe.

Students play by editing the board state in JSON (the game starts from an empty board). The state and a typed question (`instruction.json`) are sent to a **Jev-style decision endpoint**. Jev returns a **typed decision**: a probability for every cell plus an overall confidence — no prose, nothing to parse.

Two game modes:

- **1 player — standalone.** You play X by editing the board JSON; Jev plays O from its own probabilities. The classic tutorial flow.
- **2 players — classroom match.** One student creates a board and shares a 4-character code; another joins with it. The server hosts **only the shared board state** (turns, move legality, win/draw). Each player still uses **their own Jev endpoint** (the classroom proxy or their own local model) to decide moves — and only sees **their own** response panel.

## Architecture

One Node process serves everything on a single port:

```
Browser ── static files ──────────────► dist/ (built React app)
    │
    ├── REST  /api/games…  ──────────► in-memory room store (authoritative board state)
    ├── WS    /ws?token=…  ──────────► pushes board snapshots to both players
    └── POST  /api/jev     ──────────► Jev proxy: adds the server-side API key + model,
                                        re-validates with Ajv, forwards to OpenRouter
```

- **The game server never talks to a model.** It only hosts room state. All Jev calls either go through the small `/api/jev` proxy (classroom mode) or directly from the browser to the student's own local endpoint (local mode).
- **The OpenRouter key is a server runtime secret.** It lives in `JEV_API_KEY` (env var or `.env` file, loaded at startup by the Node process) and is **never** shipped in the JS bundle. The old `VITE_JEV_*` build-time variables are gone.
- **Local endpoint settings stay browser-local.** A student's own Ollama/LM Studio base URL + model id live in that browser's `localStorage` and are sent only to their own local server — never to the game server.

### 2-player flow

1. Player A: *2 players → Create board* → gets a code (e.g. `K7Q3`) and is **X**.
2. Player B: *2 players → Join a board* with that code → is **O**.
3. On their turn, a player edits the **State** JSON (or applies Jev's move into it) and clicks **Send move**.
4. The server validates: correct turn, exactly one changed cell, cell was empty, piece matches the player's role. Valid moves commit; both browsers resync to the canonical board via WebSocket (with a slow poll as fallback). Invalid moves are rejected with a reason and the local editor text is preserved.
5. Win/draw is detected server-side; **Rematch** resets the same room.

Sessions (room code + token) persist in `localStorage`, so refreshing or reopening the tab resumes the game. Room state is in memory: rooms idle out after ~30 minutes and are gone when the process restarts — fine for a classroom, which is why this app targets Node hosts (Render / Railway / VPS), not serverless platforms.

## Run it locally

```bash
npm install
cp .env.example .env    # fill in JEV_API_KEY (or set env vars)
npm run dev             # Vite on :5173 + game server on :8080, /api and /ws proxied
```

Open http://localhost:5173. For a production-mode local test:

```bash
npm run build
npm start               # one process on :8080 serving the app + API
```

## Configuration

Runtime environment variables (set as platform env vars, or in a `.env` file next to the repo — loaded at server startup, gitignored):

| Variable        | Default                                        | Meaning                                    |
| --------------- | ---------------------------------------------- | ------------------------------------------ |
| `PORT`          | `8080`                                         | Port for the whole app                     |
| `JEV_API_URL`   | `https://openrouter.ai/api/alpha/decisions`    | Full request URL of the classroom Jev endpoint |
| `JEV_API_KEY`   | *(none)*                                       | API key for that endpoint — stays on the server |
| `JEV_MODEL`     | *(none)*                                       | Model id served at that endpoint, e.g. `typesafe/jev-1.14` |

If `JEV_API_URL`/`JEV_MODEL` aren't set, the app still works: 2-player mode is unaffected (it never calls the proxy), and solo/local mode just uses a student's local endpoint. The "classroom Jev" option in Endpoint settings will show a server error until the proxy is configured.

### Local endpoints (student self-hosted, privacy-first)

In **Endpoint settings**, tick **“Use my local endpoint”**. Presets target TypeSafe's **System One API** (`POST /v1/systemone`) — the same typed-decision format as Jev (`{model, state, questions}` → probabilities), *not* chat completions:

- **Ollama (v0.35+)** — `http://localhost:11434/v1/systemone`. Pull a decision model first:
  ```bash
  ollama pull nimble      # Bespoke Labs 9B decision model
  # also available: tev1, tev1:0.8b (Together AI)
  ```
- **LM Studio** — `http://localhost:1234/v1/systemone`. Load a decision model and use its exact model id.

No API key is needed for local servers. Any custom OpenAI-compatible chat endpoint can still be used by typing a `/chat/completions` path (the app wraps the same state+questions JSON in messages).

> **CORS note:** a browser can only call a local model if that server allows cross-origin requests from the page's origin. Ollama: set `OLLAMA_ORIGINS=*` (or add your origin) and restart. LM Studio: enable CORS in the server settings. A failed local request with a network error is almost always this.

## Safety / input validation

- **Browser:** every Jev request is validated against JSON schemas (Ajv) before anything is sent — the state must be exactly a 3×3 grid of `"X" | "O" | "."`, `instruction.json` must match the typed-question shape, and the final payload is schema-checked too. Malformed input never reaches a model; the Run button is disabled and specific errors are shown inline.
- **Server (2-player):** moves are re-validated authoritatively — board shape, exactly one changed cell, empty target, correct piece, correct turn order. Clients can't skip turns, place two pieces, or edit the opponent's marks.
- **Server (Jev proxy):** `/api/jev` accepts only `{state, questions}`, re-validates both with Ajv, rate-limits per IP, and strips anything else. The key is added server-side and never appears in responses or the bundle.

## How a Jev request works

The State editor's JSON is sent as `state` and `instruction.json` *is* the `questions` object:

```
POST /api/jev                                  (classroom proxy — same shape, key added server-side)
{ "state": <State editor JSON>, "questions": <instruction.json> }
```

which the proxy forwards as:

```
POST https://openrouter.ai/api/alpha/decisions
{ "model": "typesafe/jev-1.14", "state": …, "questions": … }
```

Response (structured, no text to parse):

```json
{
  "model": "typesafe/jev-1.14-20261014",
  "provider": "TypeSafe",
  "answers": { "game": { "type": "choice", "choice": "c1-r2", "confidence": 0.61, "probabilities": { "…": "…" } } },
  "usage": { "input_tokens": 555, "output_tokens": 110, "cost": 0.000023 }
}
```

The parser is tolerant (accepts `{answers:{game:{...}}}`, direct `{choice, probabilities, confidence}`, markdown fences, or prose-wrapped JSON) so the **chat-completions fallback** for local endpoints works too.

## Deploying

One Node process, one port — deploy anywhere that runs a long-lived Node server with WebSockets. Room state is in memory, so use a single instance (no horizontal scaling without adding external state).

### Render

1. New **Web Service** from the repo.
2. Build command: `npm ci && npm run build` · Start command: `npm start`.
3. Add env vars: `JEV_API_URL`, `JEV_API_KEY`, `JEV_MODEL` (Render injects `PORT` automatically).
4. Free tier sleeps after inactivity; the first request after a sleep is slow and any in-flight rooms are lost — acceptable for class hours, or use a paid instance.

### Railway

1. New project → deploy from the repo (Nixpacks/Railpack detect Node automatically).
2. Set `JEV_API_URL`, `JEV_API_KEY`, `JEV_MODEL` in Variables. Default start (`npm start`) works; add it explicitly if needed.
3. Railway assigns a public URL with WebSocket support out of the box.

### VPS (any Linux box)

```bash
git clone <repo> && cd tic-tac-toe-server
npm ci && npm run build
# env vars, e.g. via systemd:
JEV_API_URL=… JEV_API_KEY=… JEV_MODEL=typesafe/jev-1.14 \
  nohup npm start > server.log 2>&1 &
```

Better: a `systemd` unit with the three `JEV_*` variables in `Environment=` (or an `EnvironmentFile=`), plus a reverse proxy (Caddy/nginx) for TLS. Caddy handles WebSocket upgrades automatically; nginx needs `proxy_http_version 1.1` + `Upgrade`/`Connection` headers for `/ws`.

> **Not Vercel:** serverless functions can't hold in-memory rooms or long-lived WebSockets. This app is designed for the Node hosts above.

## Stack

React 19 · TypeScript · Vite · Tailwind CSS v4 · Ajv · Node (no framework) · `ws`
