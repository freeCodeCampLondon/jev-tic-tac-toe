#!/usr/bin/env node
/**
 * Jev Tic-Tac-Toe — classroom game server.
 *
 * One small Node process that:
 *
 *   1. Serves the built frontend from dist/ (run `npm run build` first).
 *   2. Hosts 2-player game rooms in memory: authoritative board state, turn
 *      enforcement, win/draw detection, short shareable codes.
 *   3. Syncs moves between the two players over a WebSocket (REST endpoints
 *      do the mutations; the socket only pushes full-state snapshots).
 *   4. Proxies Jev requests to the configured decision endpoint. The API key
 *      lives ONLY in this process's environment (a .env file or platform env
 *      vars) and is never sent to any browser or shipped in the JS bundle.
 *
 * The server never makes game decisions: it only hosts state. Each player's
 * own Jev endpoint (the classroom proxy above, or their own local Ollama /
 * LM Studio model) is called from their own browser, exactly like solo mode.
 *
 * Configuration (environment variables, read at runtime):
 *   PORT        — HTTP port (default 8080)
 *   JEV_API_URL — full decision-endpoint URL (e.g. OpenRouter Decisions API)
 *   JEV_API_KEY — API key for that endpoint (never leaves this process)
 *   JEV_MODEL   — model id served at that endpoint
 */

import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DIST = join(ROOT, "dist");

// ---------------------------------------------------------------------------
// .env loading — runtime only. Values here never reach the browser.
// Existing environment variables (e.g. set by Render/Railway/a VPS) win.
// ---------------------------------------------------------------------------
function loadEnvFile() {
  const file = join(ROOT, ".env");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trim().startsWith("#")) continue;
    let value = m[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}
loadEnvFile();

const PORT = Number(process.env.PORT || 8080);
const JEV_API_URL = process.env.JEV_API_URL || "";
const JEV_API_KEY = process.env.JEV_API_KEY || "";
const JEV_MODEL = process.env.JEV_MODEL || "";

// ---------------------------------------------------------------------------
// Tic-tac-toe rules (mirrors src/lib/game.ts on the client — the server is
// the authority, so it re-checks everything instead of trusting the client).
// ---------------------------------------------------------------------------
const CELL_RE = /^[XO.]$/;

function emptyBoard() {
  return Array.from({ length: 3 }, () => Array(3).fill("."));
}

function isValidBoard(b) {
  return (
    Array.isArray(b) &&
    b.length === 3 &&
    b.every((row) => Array.isArray(row) && row.length === 3 && row.every((c) => typeof c === "string" && CELL_RE.test(c)))
  );
}

/** Whose turn it is based on piece counts. X always starts. */
function currentTurn(board) {
  let x = 0, o = 0;
  for (const row of board) for (const c of row) {
    if (c === "X") x++;
    else if (c === "O") o++;
  }
  return x === o ? "X" : "O";
}

const LINES = [
  [[0, 0], [0, 1], [0, 2]],
  [[1, 0], [1, 1], [1, 2]],
  [[2, 0], [2, 1], [2, 2]],
  [[0, 0], [1, 0], [2, 0]],
  [[0, 1], [1, 1], [2, 1]],
  [[0, 2], [1, 2], [2, 2]],
  [[0, 0], [1, 1], [2, 2]],
  [[0, 2], [1, 1], [2, 0]],
];

function findWinner(board) {
  for (const line of LINES) {
    const [a, b, c] = line;
    const v = board[a[0]][a[1]];
    if (v !== "." && board[b[0]][b[1]] === v && board[c[0]][c[1]] === v) {
      return { winner: v, line };
    }
  }
  return null;
}

function isFull(board) {
  for (const row of board) for (const c of row) if (c === ".") return false;
  return true;
}

// ---------------------------------------------------------------------------
// Rooms. In-memory on purpose: a classroom needs maybe a dozen live games,
// and nothing here must survive a restart. Idle rooms are swept periodically.
// ---------------------------------------------------------------------------
const rooms = new Map(); // code -> room
const tokens = new Map(); // session token -> { code, role }

// No I/L/O/0/1 — every character is unambiguous when read out loud in class.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function newCode() {
  for (;;) {
    const code = Array.from({ length: 4 }, () => CODE_ALPHABET[randomBytes(1)[0] % CODE_ALPHABET.length]).join("");
    if (!rooms.has(code)) return code;
  }
}

const IDLE_TTL_MS = 30 * 60 * 1000; // sweep rooms idle for 30 minutes
const MAX_ROOMS = 500;

function makeRoom(code) {
  return {
    code,
    board: emptyBoard(),
    status: "waiting", // waiting | playing | finished
    winner: null,
    line: null,
    draw: false,
    players: { X: null, O: null }, // role -> session token
    sockets: new Map(), // session token -> Set<WebSocket> (a player may have tabs)
    createdAt: Date.now(),
    lastActivity: Date.now(),
  };
}

function touch(room) {
  room.lastActivity = Date.now();
}

/** Full state as sent to a specific player. Deliberately complete: the
 *  client just replaces its view, which makes resync after any hiccup
 *  trivial. opponentConnected is per-player (each sees their opponent). */
function snapshotFor(room, role) {
  const oppRole = role === "X" ? "O" : "X";
  const oppToken = room.players[oppRole];
  return {
    code: room.code,
    board: room.board,
    status: room.status,
    turn: currentTurn(room.board),
    winner: room.winner,
    line: room.line,
    draw: room.draw,
    opponentConnected: !!oppToken && (room.sockets.get(oppToken)?.size ?? 0) > 0,
  };
}

function broadcast(room) {
  for (const [token, set] of room.sockets) {
    const role = tokens.get(token)?.role;
    if (!role) continue;
    const msg = JSON.stringify({ type: "snapshot", snapshot: snapshotFor(room, role) });
    for (const ws of set) if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

function deleteRoom(code) {
  const room = rooms.get(code);
  if (!room) return;
  for (const [token, set] of room.sockets) {
    tokens.delete(token);
    for (const ws of set) ws.close(1000, "room closed");
  }
  rooms.delete(code);
}

setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (now - room.lastActivity > IDLE_TTL_MS) deleteRoom(room.code);
  }
  // Safety valve: if we somehow exceed the cap, evict the most idle rooms.
  if (rooms.size > MAX_ROOMS) {
    [...rooms.values()]
      .sort((a, b) => a.lastActivity - b.lastActivity)
      .slice(0, rooms.size - MAX_ROOMS)
      .forEach((r) => deleteRoom(r.code));
  }
}, 5 * 60 * 1000).unref();

// ---------------------------------------------------------------------------
// Move validation — the heart of turn enforcement. A legal move is:
// exactly one cell changed, that cell was empty, and it now holds the
// moving player's piece (which also implies it is their turn).
// ---------------------------------------------------------------------------
function validateMove(room, role, newBoard) {
  if (!isValidBoard(newBoard)) return "The sent board is not a valid 3×3 grid of \"X\", \"O\" or \".\"";
  const diffs = [];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      if (room.board[r][c] !== newBoard[r][c]) diffs.push({ r, c, from: room.board[r][c], to: newBoard[r][c] });
    }
  }
  if (diffs.length === 0) return "No change — place your piece in the State JSON first.";
  if (diffs.length > 1) return `A move changes exactly one cell — you changed ${diffs.length}.`;
  const { r, c, from, to } = diffs[0];
  if (from !== ".") return `Cell c${c + 1}-r${r + 1} is already occupied.`;
  if (to !== role) return `You play ${role} — that move places a ${to}.`;
  const turn = currentTurn(room.board);
  if (turn !== role) return `Not your turn — it's ${turn}'s turn.`;
  return null;
}

function commitMove(room, newBoard) {
  room.board = newBoard;
  const win = findWinner(newBoard);
  if (win) {
    room.status = "finished";
    room.winner = win.winner;
    room.line = win.line;
  } else if (isFull(newBoard)) {
    room.status = "finished";
    room.draw = true;
  }
  touch(room);
  broadcast(room);
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(body);
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function readJsonBody(req, limit = 100_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, "Body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new HttpError(400, "Body is not valid JSON"));
      }
    });
    req.on("error", (e) => reject(new HttpError(400, e.message)));
  });
}

// ---------------------------------------------------------------------------
// Jev proxy — the browser sends {state, questions}; this process adds the
// model id and the API key from its own environment. The key is never
// included in any response, and input is re-validated here (defense in depth:
// it also keeps the teacher's key scoped to decision-shaped requests).
// ---------------------------------------------------------------------------
const jevRate = new Map(); // ip -> timestamps[]
function jevRateLimitOk(ip) {
  const now = Date.now();
  const recent = (jevRate.get(ip) || []).filter((t) => now - t < 10_000);
  if (recent.length >= 20) {
    jevRate.set(ip, recent);
    return false;
  }
  recent.push(now);
  jevRate.set(ip, recent);
  // Opportunistic cleanup so the map can't grow unbounded.
  if (jevRate.size > 1000) {
    for (const [key, ts] of jevRate) if (now - ts[ts.length - 1] > 60_000) jevRate.delete(key);
  }
  return true;
}

function validateJevRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "Body must be a JSON object";
  const { state, questions } = body;
  if (state === undefined || state === null || typeof state !== "object") return 'Missing "state" (the board JSON)';
  if (!questions || typeof questions !== "object" || Array.isArray(questions)) return 'Missing "questions" object';
  const names = Object.keys(questions);
  if (names.length === 0) return '"questions" must contain at least one question';
  if (names.length > 10) return "Too many questions";
  for (const name of names) {
    const q = questions[name];
    if (!q || typeof q !== "object" || Array.isArray(q)) return `Question "${name}" must be an object`;
    if (!["choice", "score", "noul"].includes(q.type)) return `Question "${name}" has unsupported type "${q.type}"`;
  }
  // If the state carries a board (as this app always does), enforce its shape
  // so the key can only be spent on tic-tac-toe-shaped states.
  if (state.board !== undefined && !isValidBoard(state.board)) {
    return '"state.board" must be a 3×3 grid of "X", "O" or "."';
  }
  return null;
}

async function handleJevProxy(req, res) {
  if (!JEV_API_URL || !JEV_API_KEY || !JEV_MODEL) {
    return json(res, 503, {
      error: "Classroom Jev is not configured on the server — set JEV_API_URL, JEV_API_KEY and JEV_MODEL (see .env.example).",
    });
  }
  const ip = req.socket.remoteAddress || "unknown";
  if (!jevRateLimitOk(ip)) return json(res, 429, { error: "Too many Jev requests — please wait a moment." });

  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    return json(res, e.status || 400, { error: e.message });
  }
  const problem = validateJevRequest(body);
  if (problem) return json(res, 400, { error: problem });

  let upstream;
  try {
    upstream = await fetch(JEV_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${JEV_API_KEY}`,
      },
      body: JSON.stringify({ model: JEV_MODEL, state: body.state, questions: body.questions }),
    });
  } catch (e) {
    return json(res, 502, { error: `Could not reach the decision endpoint: ${e.message}` });
  }

  const text = await upstream.text();
  res.writeHead(upstream.status, {
    "Content-Type": upstream.headers.get("content-type") || "application/json",
    "Cache-Control": "no-store",
  });
  res.end(text);
}

// ---------------------------------------------------------------------------
// Game REST endpoints
// ---------------------------------------------------------------------------
function requireRoom(code) {
  const room = rooms.get(code.toUpperCase());
  if (!room) throw new HttpError(404, `No board with code ${code.toUpperCase()} — check the code and try again.`);
  touch(room);
  return room;
}

/** The session token identifies a player (role within a room). */
function requirePlayer(room, token) {
  if (!token || !tokens.has(token)) throw new HttpError(401, "Unknown session — create or join the board again.");
  const identity = tokens.get(token);
  if (identity.code !== room.code) throw new HttpError(403, "This session belongs to a different board.");
  return identity.role;
}

async function handleCreateGame(req, res) {
  await readJsonBody(req).catch(() => ({})); // body is ignored; keep it optional
  const code = newCode();
  const room = makeRoom(code);
  const token = randomBytes(24).toString("hex");
  room.players.X = token;
  tokens.set(token, { code, role: "X" });
  rooms.set(code, room);
  json(res, 201, { code, role: "X", token, snapshot: snapshotFor(room, "X") });
}

async function handleJoinGame(req, res, code) {
  await readJsonBody(req).catch(() => ({}));
  const room = requireRoom(code);
  if (room.status !== "waiting") throw new HttpError(409, "That board already has two players.");
  const token = randomBytes(24).toString("hex");
  room.players.O = token;
  tokens.set(token, { code: room.code, role: "O" });
  room.status = "playing";
  touch(room);
  broadcast(room); // tells the creator their opponent arrived
  json(res, 200, { code: room.code, role: "O", token, snapshot: snapshotFor(room, "O") });
}

async function handleGetGame(req, res, url, code) {
  const room = requireRoom(code);
  const role = requirePlayer(room, url.searchParams.get("token") || "");
  json(res, 200, { role, snapshot: snapshotFor(room, role) });
}

async function handleMove(req, res, code) {
  const room = requireRoom(code);
  const body = await readJsonBody(req);
  const role = requirePlayer(room, body.token);
  if (room.status !== "playing") throw new HttpError(409, "The game is over — start a rematch to play again.");
  const problem = validateMove(room, role, body.board);
  if (problem) throw new HttpError(400, problem);
  commitMove(room, body.board);
  json(res, 200, { snapshot: snapshotFor(room, role) });
}

async function handleRematch(req, res, code) {
  const room = requireRoom(code);
  const body = await readJsonBody(req);
  const role = requirePlayer(room, body.token);
  if (room.status !== "finished") throw new HttpError(409, "The game is not over yet.");
  room.board = emptyBoard();
  room.status = "playing";
  room.winner = null;
  room.line = null;
  room.draw = false;
  touch(room);
  broadcast(room);
  json(res, 200, { snapshot: snapshotFor(room, role) });
}

// ---------------------------------------------------------------------------
// WebSocket — /ws?token=<session token>. One-way channel: the server pushes
// full snapshots whenever anything changes. Clients also poll GET as a
// fallback, so this is best-effort transport, not the source of truth.
// ---------------------------------------------------------------------------
const httpServer = createServer(handleRequest);

const wss = new WebSocketServer({ noServer: true });

httpServer.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url || "/", "http://localhost");
  if (url.pathname !== "/ws") {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }
  const token = url.searchParams.get("token") || "";
  const identity = tokens.get(token);
  if (!identity) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const room = rooms.get(identity.code);
    if (!room) {
      ws.close(1000, "room closed");
      return;
    }
    touch(room);
    let set = room.sockets.get(token);
    if (!set) {
      set = new Set();
      room.sockets.set(token, set);
    }
    set.add(ws);
    ws.send(JSON.stringify({ type: "snapshot", snapshot: snapshotFor(room, identity.role) }));
    broadcast(room); // presence (opponentConnected) may have changed

    ws.on("message", (data) => {
      if (data.toString() === "ping") ws.send("pong");
    });
    ws.on("close", () => {
      set.delete(ws);
      if (set.size === 0) room.sockets.delete(token);
      touch(room);
      broadcast(room); // presence may have changed
    });
  });
});

// Keepalive: drop dead connections so presence stays honest.
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30_000).unref();

// ---------------------------------------------------------------------------
// Static files from dist/
// ---------------------------------------------------------------------------
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".map": "application/json",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
};

function serveStatic(req, res, url) {
  if (!existsSync(DIST)) {
    return json(res, 503, { error: "Frontend not built yet — run `npm run build`, then restart the server." });
  }
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400).end("Bad request");
    return;
  }
  if (pathname === "/") pathname = "/index.html";
  const file = normalize(join(DIST, pathname));
  if (!file.startsWith(DIST)) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  const target = existsSync(file) && statSync(file).isFile() ? file : join(DIST, "index.html"); // SPA fallback
  const type = MIME[extname(target)] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": type });
  res.end(readFileSync(target));
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
async function handleRequest(req, res) {
  const url = new URL(req.url || "/", "http://localhost");
  const path = url.pathname;
  const method = req.method || "GET";

  try {
    if (path === "/api/games" && method === "POST") return await handleCreateGame(req, res);
    let m;
    if ((m = /^\/api\/games\/([^/]+)\/join$/.exec(path)) && method === "POST") return await handleJoinGame(req, res, m[1]);
    if ((m = /^\/api\/games\/([^/]+)\/move$/.exec(path)) && method === "POST") return await handleMove(req, res, m[1]);
    if ((m = /^\/api\/games\/([^/]+)\/rematch$/.exec(path)) && method === "POST") return await handleRematch(req, res, m[1]);
    if ((m = /^\/api\/games\/([^/]+)$/.exec(path)) && method === "GET") return await handleGetGame(req, res, url, m[1]);
    if (path === "/api/jev" && method === "POST") return await handleJevProxy(req, res);
    if (path.startsWith("/api/")) return json(res, 404, { error: "Unknown API endpoint" });
    if (method === "GET" || method === "HEAD") return serveStatic(req, res, url);
    res.writeHead(405).end();
  } catch (e) {
    if (e instanceof HttpError) json(res, e.status, { error: e.message });
    else {
      console.error(`[server] ${method} ${path} failed:`, e);
      json(res, 500, { error: "Internal server error" });
    }
  }
}

httpServer.listen(PORT, () => {
  console.log(`Jev Tic-Tac-Toe server listening on http://localhost:${PORT}`);
  if (JEV_API_URL && JEV_API_KEY && JEV_MODEL) {
    console.log(`Classroom Jev proxy: ${JEV_MODEL} via ${new URL(JEV_API_URL).host} (key stays on the server)`);
  } else {
    console.log("Classroom Jev proxy DISABLED — set JEV_API_URL, JEV_API_KEY and JEV_MODEL to enable it.");
  }
  if (!existsSync(DIST)) {
    console.log("Note: dist/ not found — run `npm run build` to serve the frontend from this server.");
  }
});
