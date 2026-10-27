import type { Board } from "../lib/game";
import { criterionToCell } from "../lib/game";
import type { JevChoiceAnswer } from "../lib/jev";

interface Props {
  board: Board;
  answer: JevChoiceAnswer | null;
  winningLine?: [number, number][];
}

export default function BoardView({ board, answer, winningLine }: Props) {
  const winSet = new Set((winningLine ?? []).map(([r, c]) => `${r},${c}`));
  const pickCell = answer?.choice ? criterionToCell(answer.choice) : null;

  // probability per cell from the answer
  const probByCell: Record<string, number> = {};
  if (answer) {
    for (const [crit, p] of Object.entries(answer.probabilities)) {
      const cell = criterionToCell(crit);
      if (cell) probByCell[`${cell.row},${cell.col}`] = p;
    }
  }
  const maxProb = answer ? Math.max(0, ...Object.values(answer.probabilities)) : 0;

  return (
    <div className="grid grid-cols-3 gap-2 w-full aspect-square max-w-[420px] mx-auto select-none">
      {board.map((row, r) =>
        row.map((cell, c) => {
          const key = `${r},${c}`;
          const prob = probByCell[key];
          const isPick = !!pickCell && pickCell.row === r && pickCell.col === c;
          const isWin = winSet.has(key);
          const empty = cell === ".";

          // confidence heat: amber tint scaled by probability (only on empty cells)
          const heat = prob !== undefined && empty ? Math.min(1, prob / Math.max(maxProb, 0.001)) : 0;

          return (
            <div
              key={key}
              className={[
                "relative flex items-center justify-center rounded-xl border text-5xl font-bold transition-all duration-200",
                "aspect-square cursor-default",
                isWin
                  ? "border-emerald-400 bg-emerald-500/20"
                  : isPick
                    ? "border-amber-400 ring-2 ring-amber-400/70 bg-amber-500/10"
                    : "border-zinc-700 bg-zinc-900",
              ].join(" ")}
              style={heat > 0 ? { backgroundColor: `rgba(245, 158, 11, ${0.06 + heat * 0.22})` } : undefined}
              title={prob !== undefined ? `P(${cell === "." ? "empty" : cell}) = ${(prob * 100).toFixed(1)}%` : undefined}
            >
              <span className={cell === "X" ? "text-sky-400" : cell === "O" ? "text-rose-400" : "text-zinc-600"}>
                {cell}
              </span>

              {prob !== undefined && empty && (
                <span className="absolute bottom-1 right-2 text-[11px] font-mono text-amber-300/90">
                  {(prob * 100).toFixed(0)}%
                </span>
              )}
              {isPick && empty && (
                <span className="absolute top-1 left-2 rounded bg-amber-400 px-1.5 py-0.5 text-[10px] font-semibold text-zinc-950">
                  Jev's pick
                </span>
              )}
            </div>
          );
        }),
      )}
    </div>
  );
}
