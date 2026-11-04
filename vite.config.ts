import { realpathSync } from "node:fs";
import { defineConfig, searchForWorkspaceRoot } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
// BAKERY_API_TARGET points the dev UI at another Bakery server, e.g. a remote one over Tailscale.
const apiTarget = process.env.BAKERY_API_TARGET ?? "http://127.0.0.1:4317";
// node_modules may be a symlink (scripts/verify.sh links the main checkout's), so allow its real path too.
export default defineConfig({ plugins: [react(), tailwindcss()], server: { host: "127.0.0.1", port: Number(process.env.BAKERY_VITE_PORT ?? 5173), strictPort: true, fs: { allow: [searchForWorkspaceRoot(process.cwd()), realpathSync("node_modules")] }, proxy: { "/api": { target: apiTarget, changeOrigin: true, configure: proxy => proxy.on("proxyReq", (request, incoming) => { if (request.getHeader("origin") === `http://${incoming.headers.host}`) request.setHeader("origin", new URL(apiTarget).origin); }) } } } });
