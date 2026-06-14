import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  plugins: [svelte({ hot: false })],
  resolve: {
    alias: { "~": fileURLToPath(new URL("./src", import.meta.url)) },
    conditions: ["browser"],
  },
  test: { environment: "jsdom", globals: true, include: ["src/**/*.test.ts"] },
});
