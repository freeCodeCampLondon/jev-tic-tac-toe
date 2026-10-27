#!/usr/bin/env node
/**
 * Dev runner: starts the Vite dev server and the game server together,
 * prefixing each line of output. Ctrl-C stops both.
 */
import { spawn } from "node:child_process";

const PREFIX = { vite: "  [vite]   ", server: "  [server] " };
const procs = [];
let shuttingDown = false;

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const p of procs) if (!p.killed) p.kill("SIGTERM");
  setTimeout(() => process.exit(code), 300).unref();
}

function start(name, cmd, args) {
  const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
  const buffers = { out: "", err: "" };
  const forward = (stream, key) => {
    stream.on("data", (chunk) => {
      buffers[key] += chunk.toString();
      let idx;
      while ((idx = buffers[key].indexOf("\n")) !== -1) {
        const line = buffers[key].slice(0, idx);
        buffers[key] = buffers[key].slice(idx + 1);
        if (line.trim()) console.log(PREFIX[name] + line);
      }
    });
  };
  forward(child.stdout, "out");
  forward(child.stderr, "err");
  child.on("exit", (code) => {
    console.log(`${PREFIX[name]}exited with code ${code}`);
    shutdown(code ?? 0);
  });
  procs.push(child);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

console.log("Jev Tic-Tac-Toe — dev mode (Ctrl-C to stop)\n");
start("vite", process.platform === "win32" ? "npx.cmd" : "npx", ["vite"]);
start("server", process.execPath, ["server/index.mjs"]);
