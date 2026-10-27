import type { JevChoiceAnswer } from "../lib/jev";

interface Props {
  answer: JevChoiceAnswer;
  criteriaLabels: Record<string, string>; // criterion -> human label (from instruction.json)
}

export default function ConfidenceTable({ answer, criteriaLabels }: Props) {
  const entries = Object.entries(answer.probabilities).sort((a, b) => b[1] - a[1]);
  const maxP = Math.max(0.001, ...entries.map(([, p]) => p));

  return (
    <div className="flex flex-col gap-2">
      <table className="w-full border-separate border-spacing-y-1 text-sm">
        <thead>
          <tr className="text-left text-xs uppercase tracking-wide text-zinc-500">
            <th className="px-2 font-medium">game</th>
            <th className="px-2 font-medium">P(move)</th>
            <th className="w-1/3 px-2 font-medium" />
          </tr>
        </thead>
        <tbody>
          {entries.map(([crit, p]) => {
            const isChoice = crit === answer.choice;
            return (
              <tr key={crit} className={isChoice ? "text-amber-300" : "text-zinc-300"}>
                <td className="whitespace-nowrap rounded-l bg-zinc-900/80 px-2 py-1 font-mono text-xs">
                  {crit}
                  <span className="ml-2 hidden text-[11px] text-zinc-500 sm:inline">{criteriaLabels[crit] ?? ""}</span>
                </td>
                <td className={`bg-zinc-900/80 px-2 py-1 font-mono text-xs tabular-nums ${isChoice ? "font-bold" : ""}`}>
                  {(p * 100).toFixed(1)}% {isChoice && <span title="Jev's chosen move">↗</span>}
                </td>
                <td className="rounded-r bg-zinc-900/80 px-2 py-1">
                  <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-800">
                    <div
                      className={`h-full rounded-full ${isChoice ? "bg-amber-400" : "bg-sky-500/70"}`}
                      style={{ width: `${(p / maxP) * 100}%` }}
                    />
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div className="flex items-center justify-between rounded-md border border-zinc-800 bg-zinc-900/60 px-3 py-2">
        <span className="text-xs text-zinc-400">Confidence</span>
        <span className="font-mono text-sm font-semibold text-zinc-100">
          {answer.confidence !== null ? `${(answer.confidence * 100).toFixed(0)}%` : "—"}
        </span>
      </div>
    </div>
  );
}
