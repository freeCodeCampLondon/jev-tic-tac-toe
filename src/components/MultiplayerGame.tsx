import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import BoardView from "./BoardView";
import ConfidenceTable from "./ConfidenceTable";
import JsonEditor from "./JsonEditor";
import { copyToClipboard } from "../lib/clipboard";
import { applyJevChoice, boardToJson, boardsEqual, formatBoardStateText, parseBoard, type Board } from "../lib/game";
import {
  createGame,
  getGame,
  joinGame,
  loadSession,
  rematch as rematchApi,
  RoomSocket,
  saveSession,
  sendMove,
  type Role,
  type RoomSession,
  type RoomSnapshot,
} from "../lib/room";
import { buildInstructionJson } from "../lib/instructions";
import { useJevRun } from "../lib/useJevRun";
import { formatErrors, parseJsonSafe, validateInstruction, type ValidationIssue } from "../lib/schemas";
import type { AppSettings } from "../lib/settings";

interface Props {
  settings: AppSettings;
}

type Phase = "resuming" | "lobby" | "waiting" | "playing";

/**
 * 2-player classroom mode. The game server (server/index.mjs) is the authority
 * on board state: you edit the State JSON like in solo mode, then "Send move"
 * commits it — the server checks whose turn it is and that exactly one empty
 * cell gained your piece, then pushes the new board to both players. Each
 * player still uses their OWN Jev endpoint (classroom proxy or a local model)
 * to decide moves; the game server never talks to a model.
 */
export default function MultiplayerGame({ settings }: Props) {
  const [phase, setPhase] = useState<Phase>("resuming");
  const [session, setSession] = useState<RoomSession | null>(null);
  const [snapshot, setSnapshot] = useState<RoomSnapshot | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [joinCode, setJoinCode] = useState("");
  const [stateText, setStateText] = useState("");
  const [instructionText, setInstructionText] = useState(() => buildInstructionJson("X"));
  const prevServerBoardRef = useRef<Board | null>(null);
  const lastSentBoardRef = useRef<Board | null>(null);

  const applySnapshot = useCallback((s: RoomSnapshot) => {
    setSnapshot(s);
    setPhase((p) => (p === "waiting" && s.status !== "waiting" ? "playing" : p));
  }, []);
  // Keep a ref so the mount effect can call it without re-running.
  const applySnapshotRef = useRef(applySnapshot);
  applySnapshotRef.current = applySnapshot;

  // ---- resume a saved session (refresh / back from the menu) ---------------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const saved = loadSession();
      if (!saved) {
        setPhase("lobby");
        return;
      }
      try {
        const data = await getGame(saved);
        if (cancelled) return;
        setSession({ ...saved, role: data.role });
        setInstructionText(buildInstructionJson(data.role));
        applySnapshotRef.current(data.snapshot);
        // applySnapshot only flips waiting→playing; resume must pick the phase itself.
        setPhase(data.snapshot.status === "waiting" ? "waiting" : "playing");
      } catch {
        saveSession(null);
        if (!cancelled) setPhase("lobby");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ---- live sync: WebSocket + a slow poll as fallback -----------------------
  useEffect(() => {
    if (!session || (phase !== "waiting" && phase !== "playing")) return;
    const sock = new RoomSocket(session.token, applySnapshot);
    sock.connect();
    const poll = window.setInterval(async () => {
      try {
        const data = await getGame(session);
        applySnapshot(data.snapshot);
      } catch {
        /* the WebSocket covers it; next poll retries */
      }
    }, 10_000);
    return () => {
      sock.close();
      window.clearInterval(poll);
    };
  }, [session, phase, applySnapshot]);

  // ---- validation of both editors ---------------------------------------------
  const stateCheck = useMemo(() => parseBoard(stateText), [stateText]);
  const instructionIssues = useMemo<ValidationIssue[]>(() => {
    const parsed = parseJsonSafe(instructionText);
    if (!parsed.ok) return [{ path: "questions", message: `Invalid JSON: ${parsed.error}` }];
    const valid = validateInstruction(parsed.value);
    if (!valid) return formatErrors(validateInstruction.errors).map((i) => ({ path: `questions${i.path}`, message: i.message }));
    return [];
  }, [instructionText]);

  // Human labels for criteria, from instruction.json (e.g. c2-r3 -> bottom-mid)
  const criteriaLabels = useMemo<Record<string, string>>(() => {
    const parsed = parseJsonSafe(instructionText);
    if (!parsed.ok) return {};
    const game = (parsed.value as { game?: { criteria?: Record<string, string> | string[] } }).game;
    if (!game?.criteria) return {};
    if (Array.isArray(game.criteria)) return {};
    return game.criteria as Record<string, string>;
  }, [instructionText]);

  // ---- Jev (each player's own endpoint — classroom proxy or local model) -----
  const role: Role = session?.role ?? "X";
  // What we call the model this player is asking: "Jev" when it goes through
  // the classroom proxy, "AI" when it's their own locally hosted model (which
  // may not be Jev at all).
  const modelName = settings.useLocal ? "AI" : "Jev";
  const draftBoard = stateCheck.board ?? snapshot?.board ?? null;
  const { result, running, runRequest, clearResult, endpoint, epProblems } = useJevRun({
    stateText,
    instructionText,
    settings,
    piece: role,
    board: draftBoard,
    onApply: (b) => setStateText(boardToJson(b)),
    setNotice,
  });

  // ---- board text (the State editor) ----------------------------------------
  // When the server board changes, resync the editor. If the change was OUR
  // committed move, do it silently; otherwise tell the student their unsent
  // edits were replaced.
  useEffect(() => {
    if (!snapshot) return;
    const prev = prevServerBoardRef.current;
    prevServerBoardRef.current = snapshot.board;
    if (prev && boardsEqual(prev, snapshot.board)) return; // no server-side change
    setStateText(boardToJson(snapshot.board));
    const wasOurs = lastSentBoardRef.current !== null && boardsEqual(lastSentBoardRef.current, snapshot.board);
    if (prev) {
      // The board moved on — a Jev answer computed for the old board is stale.
      clearResult();
      if (!wasOurs) {
        setNotice("The shared board changed — your unsent edits were replaced with the current board.");
      }
    }
  }, [snapshot, clearResult]);

  // ---- actions ----------------------------------------------------------------

  const doCreate = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const { session: s, snapshot: snap } = await createGame();
      setSession(s);
      setInstructionText(buildInstructionJson(s.role));
      applySnapshot(snap);
      setPhase("waiting");
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Could not create the board");
    } finally {
      setBusy(false);
    }
  };

  const doJoin = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const { session: s, snapshot: snap } = await joinGame(joinCode);
      setSession(s);
      setInstructionText(buildInstructionJson(s.role));
      applySnapshot(snap);
      setPhase(snap.status === "waiting" ? "waiting" : "playing");
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Could not join the board");
    } finally {
      setBusy(false);
    }
  };

  const doLeave = () => {
    saveSession(null);
    setSession(null);
    setSnapshot(null);
    setStateText("");
    prevServerBoardRef.current = null;
    lastSentBoardRef.current = null;
    setNotice(null);
    setPhase("lobby");
  };

  const doSendMove = async () => {
    if (!session || !snapshot || sending) return;
    if (stateCheck.issues.length > 0) {
      setNotice("Fix the State JSON first — invalid input never reaches the server.");
      return;
    }
    setSending(true);
    setNotice(null);
    try {
      lastSentBoardRef.current = stateCheck.board;
      const snap = await sendMove(session, stateCheck.board!);
      applySnapshot(snap);
    } catch (e) {
      lastSentBoardRef.current = null;
      setNotice(e instanceof Error ? e.message : "Could not send the move");
    } finally {
      setSending(false);
    }
  };

  const doRematch = async () => {
    if (!session) return;
    try {
      const snap = await rematchApi(session);
      applySnapshot(snap);
      setNotice(null);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Could not start the rematch");
    }
  };

  /** Combined action: write Jev's chosen cell into the State JSON and commit
   *  it to the server in one step (apply + send). If the student has also made
   *  a manual edit, the server rejects it (two changed cells) and the editor
   *  keeps their text — same rules as a hand-sent move. */
  const doApplyAndSend = async () => {
    if (!session || !snapshot || sending) return;
    if (stateCheck.issues.length > 0) {
      setNotice("Fix the State JSON first — invalid input never reaches the server.");
      return;
    }
    const ans = result?.ok ? result.answer ?? null : null;
    if (!ans?.choice || !draftBoard) return;
    if (snapshot.status !== "playing" || snapshot.turn !== role) return; // not your turn
    const applied = applyJevChoice(draftBoard, role, ans.choice);
    if (!applied.board) {
      setNotice(applied.error ?? `Could not apply ${modelName}'s move`);
      return;
    }
    setStateText(boardToJson(applied.board)); // show the move in the editor immediately
    setSending(true);
    setNotice(null);
    try {
      lastSentBoardRef.current = applied.board;
      const snap = await sendMove(session, applied.board);
      applySnapshot(snap);
    } catch (e) {
      lastSentBoardRef.current = null;
      setNotice(e instanceof Error ? e.message : "Could not send the move");
    } finally {
      setSending(false);
    }
  };

  // keyboard shortcut: cmd/ctrl + enter
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        void runRequest();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // ---- render -------------------------------------------------------------------
  if (phase === "resuming") {
    return (
      <main className="flex flex-1 items-center justify-center p-4">
        <p className="text-sm text-zinc-500">Checking for a saved game…</p>
      </main>
    );
  }

  if (phase === "lobby") {
    return (
      <main className="flex flex-1 items-center justify-center p-4">
        <div className="w-full max-w-2xl">
          <h2 className="text-lg font-bold text-zinc-100">Two-player match</h2>
          <p className="mt-1 text-sm leading-relaxed text-zinc-500">
            The server hosts only the board state. Each player uses their own model (the classroom Jev proxy or a
            locally hosted one) to decide moves — just like solo mode, but with an opponent.
          </p>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-5">
              <h3 className="text-sm font-semibold text-zinc-100">Create a board</h3>
              <p className="mt-1 text-xs leading-relaxed text-zinc-500">
                You'll be <span className="font-semibold text-sky-400">X</span> (first player). Share the code with your
                opponent — they join as O.
              </p>
              <button
                type="button"
                onClick={() => void doCreate()}
                disabled={busy}
                className="mt-3 w-full rounded-md bg-sky-600 px-4 py-2 text-sm font-semibold text-white shadow hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {busy ? "Working…" : "Create board"}
              </button>
            </section>
            <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-5">
              <h3 className="text-sm font-semibold text-zinc-100">Join a board</h3>
              <p className="mt-1 text-xs leading-relaxed text-zinc-500">
                Enter the 4-character code your classmate created. You'll be{" "}
                <span className="font-semibold text-rose-400">O</span>.
              </p>
              <input
                value={joinCode}
                onChange={(e) => setJoinCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4))}
                placeholder="e.g. K7Q3"
                className="mt-3 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-center font-mono text-lg tracking-[0.4em] text-zinc-100 outline-none placeholder:tracking-normal placeholder:text-zinc-600 focus:border-sky-600"
              />
              <button
                type="button"
                onClick={() => void doJoin()}
                disabled={busy || joinCode.length !== 4}
                className="mt-2 w-full rounded-md border border-sky-700 bg-sky-950/50 px-4 py-2 text-sm font-semibold text-sky-300 hover:bg-sky-900/50 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {busy ? "Working…" : "Join board"}
              </button>
            </section>
          </div>
          {notice && (
            <p className="mt-4 rounded-md border border-amber-900/60 bg-amber-950/40 px-3 py-2 text-xs text-amber-300">{notice}</p>
          )}
        </div>
      </main>
    );
  }

  if (phase === "waiting" && snapshot) {
    return <WaitingScreen code={snapshot.code} onLeave={doLeave} />;
  }

  if (!session || !snapshot) return null;

  const isMyTurn = snapshot.status === "playing" && snapshot.turn === role;
  const canSend = isMyTurn && stateCheck.issues.length === 0 && !sending;
  const answer = result?.ok ? result.answer ?? null : null;

  return (
    <main className="grid flex-1 gap-4 p-4 lg:grid-cols-[minmax(360px,420px)_1fr]">
      {/* left: state + questions (editable JSON) */}
      <div className="flex min-h-0 flex-col gap-4">
        <JsonEditor
          title="State"
          subtitle={isMyTurn ? "edit the board here, then Send move" : "shared board — updated by the server"}
          value={stateText}
          onChange={setStateText}
          issues={stateCheck.issues}
          formatValue={formatBoardStateText}
        />
        <JsonEditor
          title="Questions"
          subtitle={`your typed question for ${settings.useLocal ? "your model" : "Jev"} (you play ${role})`}
          value={instructionText}
          onChange={setInstructionText}
          issues={instructionIssues}
        />
      </div>

      {/* right: board + response */}
      <div className="flex min-h-0 flex-col gap-4">
        {/* board card */}
        <section className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-zinc-200">
              Board <span className="font-mono text-zinc-400">{snapshot.code}</span>
            </h2>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="rounded-full bg-zinc-800 px-3 py-1 font-medium text-zinc-300">
                You are <span className={role === "X" ? "font-semibold text-sky-400" : "font-semibold text-rose-400"}>{role}</span>
              </span>
              <span
                className={`rounded-full px-3 py-1 font-medium ${snapshot.opponentConnected ? "bg-zinc-800 text-zinc-400" : "bg-amber-950/60 text-amber-300"}`}
              >
                opponent {snapshot.opponentConnected ? "connected" : "disconnected"}
              </span>
              {snapshot.winner ? (
                <span className="rounded-full bg-emerald-500/15 px-3 py-1 font-semibold text-emerald-300">
                  {snapshot.winner} wins! 🎉
                </span>
              ) : snapshot.draw ? (
                <span className="rounded-full bg-zinc-700/40 px-3 py-1 font-semibold text-zinc-300">Draw</span>
              ) : isMyTurn ? (
                <span className="rounded-full bg-sky-950/60 px-3 py-1 font-medium text-sky-300">
                  Your turn — send your own move from the State JSON, or apply {modelName}'s
                </span>
              ) : (
                <span className="rounded-full bg-zinc-800 px-3 py-1 font-medium text-zinc-400">
                  Waiting for {snapshot.turn}'s move…
                </span>
              )}
            </div>
          </div>

          {draftBoard ? (
            <BoardView board={draftBoard} answer={answer} winningLine={snapshot.line ?? undefined} />
          ) : (
            <div className="mx-auto flex aspect-square max-w-[420px] items-center justify-center rounded-xl border border-dashed border-zinc-700 text-sm text-zinc-500">
              Fix the State JSON to render the board
            </div>
          )}

          {notice && (
            <p className="mt-3 rounded-md border border-amber-900/60 bg-amber-950/40 px-3 py-2 text-xs text-amber-300">{notice}</p>
          )}
        </section>

        {/* actions */}
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void runRequest()}
            disabled={running || stateCheck.issues.length > 0 || instructionIssues.length > 0 || epProblems.length > 0}
            className="rounded-md bg-sky-600 px-4 py-2 text-sm font-semibold text-white shadow hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {running ? `Asking ${modelName}…` : "Run request  ⌘⏎"}
          </button>
          <button
            type="button"
            onClick={() => void doApplyAndSend()}
            disabled={!answer || !draftBoard || !isMyTurn || sending}
            className="rounded-md border border-amber-600/70 bg-amber-500/10 px-4 py-2 text-sm font-semibold text-amber-300 hover:bg-amber-500/20 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {sending ? "Sending…" : `Apply ${modelName}'s move & send (${role})`}
          </button>
          <button
            type="button"
            onClick={() => void doSendMove()}
            disabled={!canSend}
            className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {sending ? "Sending…" : "Send move"}
          </button>
          {snapshot.status === "finished" && (
            <button
              type="button"
              onClick={() => void doRematch()}
              className="rounded-md border border-zinc-700 px-4 py-2 text-sm font-semibold text-zinc-300 hover:bg-zinc-800"
            >
              Rematch
            </button>
          )}
          <button
            type="button"
            onClick={doLeave}
            className="rounded-md border border-zinc-800 px-3 py-2 text-xs font-medium text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300"
          >
            Leave
          </button>
          {result && (
            <span className="font-mono text-xs text-zinc-500">
              [{endpoint.mode === "local" ? "local" : "server"}] {result.model ?? endpoint.modelId}
              {result.provider ? ` · ${result.provider}` : ""} · {result.latencyMs ?? "—"}ms
              {result.usage?.input_tokens !== undefined && ` · ${result.usage.input_tokens}+${result.usage.output_tokens} tok`}
              {result.usage?.cost !== undefined && ` · $${result.usage.cost.toFixed(5)}`}
            </span>
          )}
        </div>

        {/* response panel — this player's own model (Jev or local) only */}
        <section className="flex min-h-[260px] flex-1 flex-col rounded-lg border border-zinc-800 bg-zinc-900/60">
          <div className="flex items-center justify-between border-b border-zinc-800 px-3 py-1.5">
            <span className="text-sm font-semibold text-zinc-200">Your {modelName} response</span>
            {answer && (
              <span className="font-mono text-xs text-zinc-500">
                choice: <span className="text-amber-300">{answer.choice}</span>
              </span>
            )}
          </div>
          <div className="thin-scroll flex-1 overflow-auto p-3">
            {!result && (
              <p className="m-auto max-w-sm text-center text-xs leading-relaxed text-zinc-500">
                Press <span className="font-semibold text-zinc-300">Run request</span> to ask your own{" "}
                {settings.useLocal ? "model" : "Jev"} endpoint about the current board. Only you see this panel — your
                opponent sees theirs.
              </p>
            )}

            {result && !result.ok && (
              <div className="rounded-md border border-red-900/60 bg-red-950/40 px-3 py-2 text-xs text-red-300">
                <p className="font-semibold">Request failed</p>
                <p className="mt-1 whitespace-pre-wrap">{result.error}</p>
              </div>
            )}

            {answer && (
              <ConfidenceTable answer={answer} criteriaLabels={criteriaLabels} />
            )}

            {result && result.rawContent && (
              <details className="mt-3">
                <summary className="cursor-pointer select-none text-xs font-medium text-zinc-500 hover:text-zinc-300">
                  Raw model response
                </summary>
                <pre className="thin-scroll mt-2 max-h-64 overflow-auto rounded-md border border-zinc-800 bg-zinc-950 p-3 font-mono text-[11px] leading-relaxed text-zinc-400">
                  {result.rawContent}
                </pre>
              </details>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}

/** Waiting-for-opponent screen with the shareable board code. */
function WaitingScreen({ code, onLeave }: { code: string; onLeave: () => void }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await copyToClipboard(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — the code is visible on screen */
    }
  };
  return (
    <main className="flex flex-1 items-center justify-center p-4">
      <div className="w-full max-w-md rounded-xl border border-zinc-800 bg-zinc-900/60 p-6 text-center">
        <p className="text-sm font-semibold text-zinc-200">Board created — you are X</p>
        <p className="mt-1 text-xs leading-relaxed text-zinc-500">
          Share this code. Your opponent picks “2 players → Join a board” and enters it; they'll be O.
        </p>
        <div className="mx-auto mt-4 flex items-center justify-center gap-3">
          <span className="rounded-lg border border-sky-800 bg-sky-950/40 px-6 py-3 font-mono text-4xl font-bold tracking-[0.3em] text-sky-300">
            {code}
          </span>
          <button
            type="button"
            onClick={() => void copy()}
            className={`rounded-md border px-3 py-2 text-xs font-medium ${
              copied ? "border-emerald-700 bg-emerald-950/60 text-emerald-300" : "border-zinc-700 text-zinc-300 hover:bg-zinc-800"
            }`}
          >
            {copied ? "Copied!" : "Copy"}
          </button>
        </div>
        <p className="mt-5 animate-pulse text-xs font-medium text-zinc-400">Waiting for your opponent to join…</p>
        <button
          type="button"
          onClick={onLeave}
          className="mt-5 rounded-md border border-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300"
        >
          Leave
        </button>
      </div>
    </main>
  );
}
