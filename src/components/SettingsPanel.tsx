import { useState } from "react";
import type { AppSettings } from "../lib/settings";
import { LOCAL_PRESETS, SERVER_ENDPOINT, endpointProblems, protocolForPath } from "../lib/settings";

interface Props {
  settings: AppSettings;
  onChange: (s: AppSettings) => void;
}

export default function SettingsPanel({ settings, onChange }: Props) {
  const [showKey, setShowKey] = useState(false);
  const problems = endpointProblems(settings);
  const local = settings.local;
  // Match the preset by endpoint (not by stored name) so browsers that saved
  // settings under an older preset label still show the right option selected.
  const activePreset = LOCAL_PRESETS.find((p) => p.baseUrl === local.baseUrl && p.apiPath === local.apiPath);

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
      <div>
        <h3 className="text-sm font-semibold text-zinc-200">Model endpoint</h3>
        <p className="mt-0.5 text-xs leading-relaxed text-zinc-500">
          Privacy first: your board state and any local credentials only ever go to the endpoint you choose below —
          nowhere else. Use the server-hosted Jev, or point the app at your own self-hosted model.
        </p>
      </div>

      {/* mode toggle */}
      <label className="flex cursor-pointer items-start gap-2 rounded-md border border-zinc-700 bg-zinc-950/60 px-3 py-2">
        <input
          type="checkbox"
          checked={settings.useLocal}
          onChange={(e) => onChange({ ...settings, useLocal: e.target.checked })}
          className="mt-0.5 h-4 w-4 accent-sky-500"
        />
        <span>
          <span className="block text-sm font-medium text-zinc-200">Use my local endpoint</span>
          <span className="block text-[11px] leading-relaxed text-zinc-500">
            Private &amp; self-hosted — requests go directly from this browser to your own server (e.g. Ollama, LM Studio),
            and its credentials never leave the browser.
          </span>
        </span>
      </label>

      {settings.useLocal ? (
        <>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-zinc-400">Preset</span>
            <select
              value={activePreset ? activePreset.name : "custom"}
              onChange={(e) => {
                const p = LOCAL_PRESETS.find((x) => x.name === e.target.value);
                if (p) onChange({ ...settings, local: { ...local, baseUrl: p.baseUrl, apiPath: p.apiPath, modelId: p.modelId, presetName: p.name } });
              }}
              className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-200 outline-none focus:border-sky-600"
            >
              {LOCAL_PRESETS.map((p) => (
                <option key={p.name} value={p.name}>{p.name}</option>
              ))}
              <option value="custom">Custom…</option>
            </select>
          </label>

          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-zinc-400">Base URL</span>
              <input
                type="url"
                value={local.baseUrl}
                onChange={(e) => onChange({ ...settings, local: { ...local, baseUrl: e.target.value, presetName: "Custom…" } })}
                placeholder="http://localhost:11434/v1"
                className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 font-mono text-sm text-zinc-200 outline-none focus:border-sky-600"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-zinc-400">API path</span>
              <input
                type="text"
                value={local.apiPath}
                onChange={(e) => onChange({ ...settings, local: { ...local, apiPath: e.target.value, presetName: "Custom…" } })}
                placeholder="/chat/completions or /alpha/decisions"
                className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 font-mono text-sm text-zinc-200 outline-none focus:border-sky-600"
              />
            </label>
          </div>
          <p className="-mt-1 text-[11px] leading-relaxed text-zinc-600">
            Protocol: {protocolForPath(local.apiPath) === "decisions" ? (
              <span className="font-mono text-emerald-400/80">Decisions / System One — sends {`{model, state, questions}`}</span>
            ) : (
              <span className="font-mono text-sky-400/80">Chat completions — wraps the same JSON in messages (for local LLMs)</span>
            )}
          </p>

          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-zinc-400">API key</span>
            <div className="flex gap-2">
              <input
                type={showKey ? "text" : "password"}
                value={local.apiKey}
                onChange={(e) => onChange({ ...settings, local: { ...local, apiKey: e.target.value } })}
                placeholder="leave blank if the server needs no auth"
                className="min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 font-mono text-sm text-zinc-200 outline-none focus:border-sky-600"
              />
              <button
                type="button"
                onClick={() => setShowKey((v) => !v)}
                className="rounded-md border border-zinc-700 px-2 py-1.5 text-xs text-zinc-400 hover:bg-zinc-800"
              >
                {showKey ? "Hide" : "Show"}
              </button>
            </div>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-zinc-400">
              Model id <span className="font-normal text-zinc-600">(e.g. nimble, clef)</span>
            </span>
            <input
              type="text"
              value={local.modelId}
              onChange={(e) => onChange({ ...settings, local: { ...local, modelId: e.target.value } })}
              placeholder="e.g. nimble, clef"
              className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 font-mono text-sm text-zinc-200 outline-none focus:border-sky-600"
            />
          </label>

          <p className="text-[11px] leading-relaxed text-zinc-600">
            Both presets speak TypeSafe's <span className="font-mono">System One API</span> (<span className="font-mono">/v1/systemone</span>) —
            the same typed-decision format as Jev, not chat. Ollama needs v0.35+ with a decision model pulled
            (<span className="font-mono">ollama pull nimble</span>; also <span className="font-mono">tev1</span>,{" "}
            <span className="font-mono">tev1:0.8b</span>). LM Studio needs a decision model loaded — use its exact model id.
          </p>
          <p className="text-[11px] leading-relaxed text-zinc-600">
            Stored only in this browser's localStorage. If the request fails with a network error, check that the local
            server allows cross-origin requests from this page (Ollama: <span className="font-mono">OLLAMA_ORIGINS=*</span>;
            LM Studio: enable CORS).
          </p>
        </>
      ) : (
        <div className="rounded-md border border-zinc-800 bg-zinc-950/60 px-3 py-2">
          <p className="text-xs font-medium text-zinc-300">Classroom Jev — via the game server</p>
          <dl className="mt-1.5 space-y-1 font-mono text-[11px] text-zinc-400">
            <div className="flex gap-2"><dt className="w-24 shrink-0 text-zinc-600 not-italic">URL</dt><dd>{SERVER_ENDPOINT.url}</dd></div>
            <div className="flex gap-2"><dt className="w-24 shrink-0 text-zinc-600 not-italic">Model</dt><dd>configured on the server</dd></div>
            <div className="flex gap-2"><dt className="w-24 shrink-0 text-zinc-600 not-italic">API key</dt><dd>stays on the server — never sent to this browser</dd></div>
          </dl>
          <p className="mt-1.5 text-[11px] leading-relaxed text-zinc-600">
            The game server forwards your state + questions to Jev and adds the teacher's API key on its side.
            If it isn't configured there, requests fail with a message from the server.
          </p>
        </div>
      )}

      {problems.length > 0 && (
        <ul className="space-y-0.5 rounded-md border border-red-900/50 bg-red-950/40 px-3 py-2 text-xs text-red-300">
          {problems.map((p, i) => <li key={i}>{p}</li>)}
        </ul>
      )}
    </div>
  );
}
