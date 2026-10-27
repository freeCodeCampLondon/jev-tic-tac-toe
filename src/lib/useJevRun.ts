import { useRef, useState } from "react";
import { applyMove, criterionToCell, type Board } from "./game";
import { buildRequest, runJevRequest, type JevRunResult } from "./jev";
import { endpointProblems, resolveEndpoint, type AppSettings } from "./settings";

interface Args {
  stateText: string;
  instructionText: string;
  settings: AppSettings;
  /** The piece Jev plays — parsed from the instruction text in solo mode,
   *  the player's role in 2-player. */
  piece: "X" | "O";
  board: Board | null;
  onApply: (b: Board) => void;
  setNotice: (n: string | null) => void;
}

/** Shared "ask Jev" logic for both game modes: resolve the endpoint, build +
 *  schema-validate the request, run it, and apply Jev's chosen cell to the
 *  board. The model call always goes to the endpoint configured in this
 *  browser (classroom proxy or the player's own local model). */
export function useJevRun({ stateText, instructionText, settings, piece, board, onApply, setNotice }: Args) {
  const endpoint = resolveEndpoint(settings);
  const epProblems = endpointProblems(settings);
  const [result, setResult] = useState<JevRunResult | null>(null);
  const [running, setRunning] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const runRequest = async () => {
    if (running) return;
    setNotice(null);
    if (epProblems.length > 0) {
      setNotice(epProblems[0]);
      return;
    }
    const built = buildRequest({ stateText, instructionText, endpoint });
    if (!built.ok) {
      setNotice("Fix the schema validation errors before running — invalid input never reaches the model.");
      return;
    }
    setRunning(true);
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const res = await runJevRequest(built.built, endpoint, ctrl.signal);
      setResult(res);
      if (!res.ok) setNotice(res.error ?? "Request failed");
    } finally {
      setRunning(false);
    }
  };

  const applyJevMove = () => {
    if (!board || !result?.ok || !result.answer?.choice) return;
    const cell = criterionToCell(result.answer.choice);
    if (!cell) {
      setNotice(`Unknown criterion "${result.answer.choice}"`);
      return;
    }
    const next = applyMove(board, cell.row, cell.col, piece);
    if (!next) {
      setNotice(`Jev's chosen cell is already occupied — update the board and try again.`);
      return;
    }
    onApply(next);
    setResult(null);
  };

  const clearResult = () => setResult(null);

  return { result, running, runRequest, applyJevMove, clearResult, endpoint, epProblems };
}
