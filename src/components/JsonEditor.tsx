import { useState } from "react";
import { copyToClipboard } from "../lib/clipboard";
import type { ValidationIssue } from "../lib/schemas";

interface Props {
  title: string;
  subtitle?: string;
  value: string;
  onChange: (v: string) => void;
  issues: ValidationIssue[];
  /** Custom formatter for the Format button. Defaults to standard 2-space pretty-printing.
   *  Should throw on invalid JSON so the parse error stays visible. */
  formatValue?: (raw: string) => string;
}

export default function JsonEditor({ title, subtitle, value, onChange, issues, formatValue }: Props) {
  const [showErrors, setShowErrors] = useState(true);
  const [copied, setCopied] = useState(false);

  const format = () => {
    try {
      onChange(formatValue ? formatValue(value) : JSON.stringify(JSON.parse(value), null, 2));
    } catch {
      /* leave as-is; parse error already shown */
    }
  };

  const copy = async () => {
    try {
      await copyToClipboard(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <div className="flex min-h-0 flex-col rounded-lg border border-zinc-800 bg-zinc-900/60">
      <div className="flex items-center justify-between border-b border-zinc-800 px-3 py-1.5">
        <div>
          <span className="text-sm font-semibold text-zinc-200">{title}</span>
          {subtitle && <span className="ml-2 text-xs text-zinc-500">{subtitle}</span>}
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={copy}
            title={`Copy ${title} JSON to clipboard`}
            aria-label={`Copy ${title} JSON to clipboard`}
            className={`flex items-center gap-1 rounded border px-2 py-0.5 text-xs transition ${
              copied
                ? "border-emerald-700 bg-emerald-950/60 text-emerald-300"
                : "border-zinc-700 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
            }`}
          >
            {copied ? (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="h-3 w-3">
                <path d="M20 6 9 17l-5-5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3 w-3">
                <rect x="9" y="9" width="13" height="13" rx="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
            )}
            {copied ? "Copied!" : "Copy"}
          </button>
          <button
            type="button"
            onClick={format}
            className="rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
          >
            Format
          </button>
        </div>
      </div>

      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        className="thin-scroll h-full min-h-[140px] flex-1 resize-none bg-transparent p-3 font-mono text-xs leading-relaxed text-zinc-300 outline-none placeholder:text-zinc-600"
        placeholder="{ ... }"
      />

      {issues.length > 0 && showErrors && (
        <div className="max-h-28 overflow-auto border-t border-red-900/50 bg-red-950/40 px-3 py-2">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-xs font-semibold text-red-400">
              Schema validation failed — request blocked ({issues.length})
            </span>
            <button type="button" onClick={() => setShowErrors(false)} className="text-xs text-zinc-500 hover:text-zinc-300">
              hide
            </button>
          </div>
          <ul className="space-y-0.5 font-mono text-[11px] text-red-300/90">
            {issues.map((i, idx) => (
              <li key={idx}>
                <span className="text-red-400">{i.path}</span> — {i.message}
              </li>
            ))}
          </ul>
        </div>
      )}
      {issues.length > 0 && !showErrors && (
        <button
          type="button"
          onClick={() => setShowErrors(true)}
          className="border-t border-red-900/50 px-3 py-1 text-left text-xs text-red-400 hover:bg-red-950/40"
        >
          {issues.length} validation issue(s) hidden — click to show
        </button>
      )}
    </div>
  );
}
