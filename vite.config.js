import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const here = path.dirname(fileURLToPath(import.meta.url));

// One interface (UU-C-087). web/v2/index.html only redirects old Timeline bookmarks to it.
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
