import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const here = path.dirname(fileURLToPath(import.meta.url));

// Two entries, two releases. v1 (`/`) is the original dashboard and stays untouched;
// v2 (`/v2`) is the session-timeline rebuild. Both are built into dist/ and both ship
// in the image, so they can be compared against the same live data.
export default defineConfig({
  plugins: [react()],
  root: "web",
  base: "./",
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:3780",
    },
  },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: path.resolve(here, "web/index.html"),
        v2: path.resolve(here, "web/v2/index.html"),
      },
    },
  },
});
