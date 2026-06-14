import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { fileURLToPath, URL } from "node:url";

// https://vite.dev/config/
export default defineConfig({
  plugins: [svelte()],
  resolve: { alias: { "~": fileURLToPath(new URL("./src", import.meta.url)) } },
  build: { target: "es2022", outDir: "dist", sourcemap: true },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": { target: "http://127.0.0.1:4319", changeOrigin: false },
    },
  },
});
