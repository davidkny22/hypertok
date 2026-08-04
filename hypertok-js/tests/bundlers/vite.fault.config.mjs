import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const directory = path.dirname(fileURLToPath(import.meta.url));

export function faultConfig(fault, outputDirectory) {
  return defineConfig({
    base: "./",
    define: {
      __HYPERTOK_TEST_FAULT__: JSON.stringify(fault),
    },
    build: {
      emptyOutDir: false,
      minify: false,
      outDir: path.resolve(directory, outputDirectory),
      rollupOptions: {
        input: path.join(directory, "fault-entry.mjs"),
        output: {
          entryFileNames: "bundle.mjs",
          chunkFileNames: "assets/[name]-[hash].mjs",
          assetFileNames: "assets/[name]-[hash][extname]",
        },
      },
    },
  });
}
