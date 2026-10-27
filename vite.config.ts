import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// In dev, Vite serves the app on :5173 and proxies API + WebSocket traffic to
// the game server (scripts/dev.mjs starts both). In production the Node server
// serves dist/ itself on one port, so no proxy is needed.
const GAME_SERVER = process.env.GAME_SERVER_URL || "http://localhost:8080";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    allowedHosts: true,
    proxy: {
      "/api": GAME_SERVER,
      "/ws": { target: GAME_SERVER.replace(/^http/, "ws"), ws: true },
    },
  },
});
