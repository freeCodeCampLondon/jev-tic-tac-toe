import { useEffect, useMemo, useState } from "react";
import BoardView from "./BoardView";
import ConfidenceTable from "./ConfidenceTable";
import JsonEditor from "./JsonEditor";
import { boardToJson, cloneBoard, currentTurn, EMPTY_BOARD, findWinner, formatBoardStateText, isFull, parseBoard, type Board } from "../lib/game";
import { buildInstructionJson } from "../lib/instructions";
import { useJevRun } from "../lib/useJevRun";
import { formatErrors, parseJsonSafe, validateInstruction, type ValidationIssue } from "../lib/schemas";
import type { AppSettings } from "../lib/settings";

interface Props {
  settings: AppSettings;
}

/**
 * 1-player standalone mode — the original tutorial flow. You play X by
 * editing the board JSON; Jev plays O (or whatever piece the instruction
 * text says). Everything happens in this browser except the model call,
 * which goes to the configured endpoint (classroom proxy or local model).
 */
export default function SoloGame({ settings }: Props) {
  // The game starts from an empty board (embedded default — no external file),
  // formatted one-row-per-line so it's easy to edit by hand.
  const [stateText, setStateText] = useState(() => boardToJson(EMPTY_BOARD));
  // Jev plays O by default in solo mode (you play X).
  const [instructionText, setInstructionText] = useState(() => buildInstructionJson("O"));
  const [notice, setNotice] = useState<string | null>(null);

  // ---- live validation of both editors -------------------------------------
  const stateCheck = useMemo(() => parseBoard(stateText), [stateText]);
  const instructionIssues = useMemo<ValidationIssue[]>(() => {
    const parsed = parseJsonSafe(instructionText);
    if (!parsed.ok) return [{ path: "questions", message: `Invalid JSON: ${parsed.error}` }];
    const valid = validateInstruction(parsed.value);
    if (!valid) return formatErrors(validateInstruction.errors).map((i) => ({ path: `questions${i.path}`, message: i.message }));
    return [];
  }, [instructionText]);

  const board = stateCheck.board;
  const winner = board ? findWinner(board) : null;
  const full = board ? isFull(board) : false;
  const turn = board ? currentTurn(board) : "X";
  const emptyBoard = !!board && board.every((row) => row.every((c) => c === "."));

  // Which piece does Jev play? From the instruction text ("You are playing as O").
  // Accepts both the current phrasing and the older "playing with X/O".
  const jevPiece: "X" | "O" = useMemo(() => {
    const m = /playing (?:with|as) ([XO])/i.exec(instructionText);
    return m ? (m[1].toUpperCase() as "X" | "O") : "O";
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

  const setBoard = (b: Board) => setStateText(boardToJson(b));

  const { result, running, runRequest, applyJevMove, clearResult, endpoint, epProblems } = useJevRun({
    stateText,
    instructionText,
    settings,
    piece: jevPiece,
    board,
    onApply: setBoard,
    setNotice,
  });

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

  const answer = result?.ok ? result.answer ?? null : null;
  const gameOver = !!winner || full;

  return (
    <main className="grid flex-1 gap-4 p-4 lg:grid-cols-[minmax(360px,420px)_1fr]">
      {/* left: state + questions (editable JSON) */}
      <div className="flex min-h-0 flex-col gap-4">
        <JsonEditor
          title="State"
          subtitle="edit the board here to play"
          value={stateText}
          onChange={setStateText}
          issues={stateCheck.issues}
          formatValue={formatBoardStateText}
        />
        <JsonEditor
          title="Questions"
          subtitle="instruction.json — the typed question for Jev"
          value={instructionText}
          onChange={setInstructionText}
          issues={instructionIssues}
        />
      </div>

      {/* right: board + response */}
      <div className="flex min-h-0 flex-col gap-4">
        {/* board card */}
        <section className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-zinc-200">Board</h2>
            <div className="flex items-center gap-2 text-xs">
              {winner ? (
                <span className="rounded-full bg-emerald-500/15 px-3 py-1 font-semibold text-emerald-300">
                  {winner.winner} wins! 🎉
                </span>
              ) : full ? (
                <span className="rounded-full bg-zinc-700/40 px-3 py-1 font-semibold text-zinc-300">Draw</span>
              ) : (
                <span className="rounded-full bg-zinc-800 px-3 py-1 font-medium text-zinc-300">
                  Turn: <span className={turn === "X" ? "text-sky-400" : "text-rose-400"}>{turn}</span> — edit the State JSON to play
                </span>
              )}
              <button
                type="button"
                onClick={() => { setBoard(cloneBoard(EMPTY_BOARD)); clearResult(); setNotice(null); }}
                className="rounded-md border border-zinc-700 px-2 py-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
              >
                New game
              </button>
            </div>
          </div>

          {board ? (
            <BoardView board={board} answer={answer} winningLine={winner?.line} />
          ) : (
            <div className="mx-auto flex aspect-square max-w-[420px] items-center justify-center rounded-xl border border-dashed border-zinc-700 text-sm text-zinc-500">
              Fix the State JSON to render the board
            </div>
          )}

          {emptyBoard && (
            <p className="mt-3 text-center text-xs text-zinc-500">
              Empty board — it's X's turn. Place an <span className="font-semibold text-sky-400">X</span> in the State JSON to start (Jev plays O).
            </p>
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
            {running ? "Asking Jev…" : "Run request  ⌘⏎"}
          </button>
          <button
            type="button"
            onClick={applyJevMove}
            disabled={!answer || !board || gameOver}
            className="rounded-md border border-amber-600/70 bg-amber-500/10 px-4 py-2 text-sm font-semibold text-amber-300 hover:bg-amber-500/20 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Apply Jev's move ({jevPiece})
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

        {/* response panel */}
        <section className="flex min-h-[260px] flex-1 flex-col rounded-lg border border-zinc-800 bg-zinc-900/60">
          <div className="flex items-center justify-between border-b border-zinc-800 px-3 py-1.5">
            <span className="text-sm font-semibold text-zinc-200">Response</span>
            {answer && (
              <span className="font-mono text-xs text-zinc-500">
                choice: <span className="text-amber-300">{answer.choice}</span>
              </span>
            )}
          </div>
          <div className="thin-scroll flex-1 overflow-auto p-3">
            {!result && (
              <p className="m-auto max-w-sm text-center text-xs leading-relaxed text-zinc-500">
                Press <span className="font-semibold text-zinc-300">Run request</span> to send the current state + question to Jev.
                The model returns a probability for every cell — no text, just a typed decision with confidence.
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
