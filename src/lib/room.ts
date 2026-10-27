/**
 * Client for the 2-player game rooms hosted by the Node game server
 * (server/index.mjs). The server is the authority on board state; this module
 * just moves full snapshots back and forth and remembers who you are in a
 * room. The server never talks to Jev — each player's model endpoint is
 * called from their own browser, exactly like solo mode.
 */
import type { Board } from "./game";

export type Role = "X" | "O";
export type RoomStatus = "waiting" | "playing" | "finished";

/** Complete, authoritative game state as pushed by the server. Every snapshot
 *  is a full replacement — no incremental merging, which makes resync after
 *  any hiccup trivial. */
export interface RoomSnapshot {
  code: string;
  board: Board;
  status: RoomStatus;
  turn: Role;
  winner: Role | null;
  line: [number, number][] | null;
  draw: boolean;
  opponentConnected: boolean;
}

/** Who you are in a room. Stored in localStorage so a refresh (or leaving to
 *  the menu and coming back) resumes the same board and role. */
export interface RoomSession {
  code: string;
  role: Role;
  token: string;
}

const SESSION_KEY = "jev-ttt-room-v1";

export function loadSession(): RoomSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Partial<RoomSession>;
    if (typeof s.code === "string" && s.code && (s.role === "X" || s.role === "O") && typeof s.token === "string" && s.token) {
      return { code: s.code, role: s.role, token: s.token };
    }
    return null;
  } catch {
    return null;
  }
}

export function saveSession(s: RoomSession | null): void {
  try {
    if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else localStorage.removeItem(SESSION_KEY);
  } catch {
    /* storage unavailable — the game still works, refreshes just won't resume */
  }
}

/** Error with a message safe to show to students. */
export class RoomError extends Error {}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...init });
  } catch {
    throw new RoomError("Cannot reach the game server — is it running? (npm run dev locally, or check the deployment.)");
  }
  const text = await res.text();
  let data: { error?: string } & Record<string, unknown> = {};
  try {
    data = JSON.parse(text);
  } catch {
    /* non-JSON response */
  }
  if (!res.ok) throw new RoomError(data.error || `Server error (HTTP ${res.status})`);
  return data as T;
}

interface CreateJoinResponse {
  code: string;
  role: Role;
  token: string;
  snapshot: RoomSnapshot;
}

/** Create a new board. You are X (first player). */
export async function createGame(): Promise<{ session: RoomSession; snapshot: RoomSnapshot }> {
  const data = await api<CreateJoinResponse>("/api/games", { method: "POST" });
  const session = { code: data.code, role: data.role, token: data.token };
  saveSession(session);
  return { session, snapshot: data.snapshot };
}

/** Join an existing board by its code. You are O (second player). */
export async function joinGame(codeRaw: string): Promise<{ session: RoomSession; snapshot: RoomSnapshot }> {
  const code = codeRaw.trim().toUpperCase();
  if (!code) throw new RoomError("Enter the board code first.");
  const data = await api<CreateJoinResponse>(`/api/games/${encodeURIComponent(code)}/join`, { method: "POST" });
  const session = { code: data.code, role: data.role, token: data.token };
  saveSession(session);
  return { session, snapshot: data.snapshot };
}

/** Fetch the current state of a room (also used to resume after a refresh). */
export async function getGame(
  session: RoomSession,
  timeoutMs = 15_000,
): Promise<{ role: Role; snapshot: RoomSnapshot }> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await api(`/api/games/${encodeURIComponent(session.code)}?token=${encodeURIComponent(session.token)}`, { signal: controller.signal });
  } catch (e) {
    if (controller.signal.aborted) throw new RoomError("Timed out talking to the game server.");
    throw e;
  } finally {
    window.clearTimeout(timer);
  }
}

/** Commit your edited board. The server validates the turn and the move. */
export async function sendMove(session: RoomSession, board: Board): Promise<RoomSnapshot> {
  const data = await api<{ snapshot: RoomSnapshot }>(`/api/games/${encodeURIComponent(session.code)}/move`, {
    method: "POST",
    body: JSON.stringify({ token: session.token, board }),
  });
  return data.snapshot;
}

/** Reset a finished game to an empty board. Either player may start it. */
export async function rematch(session: RoomSession): Promise<RoomSnapshot> {
  const data = await api<{ snapshot: RoomSnapshot }>(`/api/games/${encodeURIComponent(session.code)}/rematch`, {
    method: "POST",
    body: JSON.stringify({ token: session.token }),
  });
  return data.snapshot;
}

/**
 * WebSocket connection to a room. The server only ever pushes full snapshots,
 * so reconnecting at any time is safe. Reconnects automatically with a small
 * backoff; the UI's slow poll covers longer outages (e.g. laptop sleep).
 */
export class RoomSocket {
  private ws: WebSocket | null = null;
  private closed = false;
  private attempt = 0;

  constructor(
    private token: string,
    private onSnapshot: (s: RoomSnapshot) => void,
  ) {}

  connect(): void {
    this.open();
  }

  close(): void {
    this.closed = true;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  private open(): void {
    if (this.closed) return;
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${window.location.host}/ws?token=${encodeURIComponent(this.token)}`);
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as { type?: string; snapshot?: RoomSnapshot };
        if (msg.type === "snapshot" && msg.snapshot) this.onSnapshot(msg.snapshot);
      } catch {
        /* ignore non-JSON keepalive frames */
      }
    };
    ws.onclose = () => {
      if (this.closed) return;
      const delay = Math.min(10_000, 500 * 2 ** this.attempt++);
      window.setTimeout(() => this.open(), delay);
    };
    ws.onerror = () => ws.close();
  }
}
