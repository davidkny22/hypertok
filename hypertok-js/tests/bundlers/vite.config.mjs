import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const directory = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  base: "./",
  build: {
    emptyOutDir: false,
    minify: false,
    outDir: path.resolve(directory, "../../../results/execution-tiers/bundlers/vite"),
    rollupOptions: {
      input: path.join(directory, "entry.mjs"),
      output: {
        entryFileNames: "bundle.mjs",
        chunkFileNames: "assets/[name]-[hash].mjs",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
});
