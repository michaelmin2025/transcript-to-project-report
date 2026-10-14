import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const projectRoot = fileURLToPath(new URL("../", import.meta.url));
  const environment = { ...loadEnv(mode, projectRoot, ""), ...process.env };
  const host = environment.HOST || "127.0.0.1";
  const proxyHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const target = `http://${proxyHost.includes(":") ? `[${proxyHost}]` : proxyHost}:${environment.PORT || 8080}`;
  return {
    root: fileURLToPath(new URL(".", import.meta.url)),
    plugins: [react()],
    server: {
      host: "127.0.0.1",
      port: 5173,
      strictPort: true,
      proxy: { "/api": { target }, "/health": { target } },
    },
    build: { outDir: "dist", emptyOutDir: true },
  };
});
