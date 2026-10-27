import { useEffect, useState } from "react";
import MultiplayerGame from "./components/MultiplayerGame";
import SettingsPanel from "./components/SettingsPanel";
import SoloGame from "./components/SoloGame";
import { loadSession } from "./lib/room";
import { loadSettings, saveSettings, type AppSettings } from "./lib/settings";

type Mode = "menu" | "solo" | "multi";

/**
 * App shell: mode selection + shared header/endpoint settings. The endpoint
 * settings (classroom proxy vs the player's own local model) apply to both
 * game modes and persist in this browser's localStorage.
 */
export default function App() {
  // If this browser has a saved room session, land straight in 2-player mode
  // (MultiplayerGame resumes it) instead of making the student click through.
  const [mode, setMode] = useState<Mode>(() => (loadSession() ? "multi" : "menu"));
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings());
  const [showSettings, setShowSettings] = useState(false);

  useEffect(() => saveSettings(settings), [settings]);

  return (
    <div className="flex min-h-full flex-col">
      {/* header */}
      <header className="flex items-center justify-between border-b border-zinc-800 bg-zinc-950/90 px-4 py-2.5">
        <button
          type="button"
          onClick={() => setMode("menu")}
          title="Back to mode selection"
          className="flex items-center gap-3 text-left"
        >
          <span className="text-lg">⚫</span>
          <span>
            <span className="block text-sm font-bold leading-tight text-zinc-100">Jev Tic-Tac-Toe</span>
            <span className="block text-[11px] leading-tight text-zinc-500">
              Teaching System One decisions — state + typed question → probabilities, no prose
            </span>
          </span>
        </button>
        {mode !== "menu" && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setMode("menu")}
              className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 hover:bg-zinc-800"
            >
              ← Menu
            </button>
            <button
              type="button"
              onClick={() => setShowSettings((v) => !v)}
              className={`rounded-md border px-3 py-1.5 text-xs font-medium ${showSettings ? "border-sky-600 bg-sky-950/50 text-sky-300" : "border-zinc-700 text-zinc-300 hover:bg-zinc-800"}`}
            >
              ⚙ Endpoint settings
            </button>
          </div>
        )}
      </header>

      {showSettings && mode !== "menu" && (
        <div className="border-b border-zinc-800 bg-zinc-900/40 px-4 py-3">
          <div className="mx-auto max-w-3xl">
            <SettingsPanel settings={settings} onChange={setSettings} />
          </div>
        </div>
      )}

      {mode === "menu" && (
        <main className="flex flex-1 items-center justify-center p-4">
          <div className="w-full max-w-3xl">
            <h2 className="text-lg font-bold text-zinc-100">How do you want to play?</h2>
            <p className="mt-1 text-sm leading-relaxed text-zinc-500">
              Both modes teach the same idea: give Jev the board state and a typed question, and it returns a probability
              for every cell — no prose.
            </p>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <button
                type="button"
                onClick={() => setMode("solo")}
                className="group rounded-xl border border-zinc-800 bg-zinc-900/60 p-5 text-left transition hover:border-sky-700 hover:bg-zinc-900"
              >
                <div className="text-2xl">🎓</div>
                <h3 className="mt-2 text-sm font-semibold text-zinc-100 group-hover:text-sky-300">1 player — standalone</h3>
                <p className="mt-1 text-xs leading-relaxed text-zinc-500">
                  You play X by editing the board JSON; Jev plays O from its own probabilities. The classic tutorial flow
                  — no room, no opponent needed.
                </p>
              </button>
              <button
                type="button"
                onClick={() => setMode("multi")}
                className="group rounded-xl border border-zinc-800 bg-zinc-900/60 p-5 text-left transition hover:border-sky-700 hover:bg-zinc-900"
              >
                <div className="text-2xl">👥</div>
                <h3 className="mt-2 text-sm font-semibold text-zinc-100 group-hover:text-sky-300">2 players — classroom match</h3>
                <p className="mt-1 text-xs leading-relaxed text-zinc-500">
                  Create a board and share its code, or join with one. The server hosts only the board state; each player
                  uses their own Jev endpoint to decide moves.
                </p>
              </button>
            </div>
          </div>
        </main>
      )}

      {mode === "solo" && <SoloGame settings={settings} />}
      {mode === "multi" && <MultiplayerGame settings={settings} />}
    </div>
  );
}
