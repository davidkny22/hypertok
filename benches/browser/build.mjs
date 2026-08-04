import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { constants as zlibConstants, gzipSync } from "node:zlib";
import { build } from "esbuild";
import { readBenchmarkTokenizer } from "../common/gpt2_model.mjs";
import {
  availableReferencesForVocabulary,
} from "../common/reference_registry.mjs";
import {
  prepareVocabularyArtifact,
  vocabularyRegistry,
} from "../common/vocabularies.mjs";

const benchesDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryDirectory = path.resolve(benchesDirectory, "..");
export const browserOutputDirectory = path.join(
  repositoryDirectory,
  "results",
  "harness",
  "browser",
);
export const referencePayloads = Object.freeze(
  vocabularyRegistry.flatMap(({ id: vocabulary }) =>
    availableReferencesForVocabulary(vocabulary).map(({ id, browserSlug }) =>
      Object.freeze({
        vocabulary,
        reference: id,
        slug: vocabulary === "gpt2" ? browserSlug : `o200k-${browserSlug}`,
      }),
    ),
  ),
);
export const referenceSlugs = Object.freeze(
  referencePayloads.map(({ slug }) => slug),
);

export async function buildBrowserBundle() {
  const packageWasmDirectory = path.join(repositoryDirectory, "hypertok-js", "wasm", "single");
  const browserWasmDirectory = path.join(browserOutputDirectory, "wasm", "single");
  const vocabularyArtifacts = vocabularyRegistry.map(({ id }) =>
    prepareVocabularyArtifact(id),
  );

  fs.mkdirSync(browserOutputDirectory, { recursive: true });
  fs.mkdirSync(browserWasmDirectory, { recursive: true });
  fs.copyFileSync(
    path.join(packageWasmDirectory, "hypertok_wasm_core.js"),
    path.join(browserWasmDirectory, "hypertok_wasm_core.js"),
  );
  fs.copyFileSync(
    path.join(packageWasmDirectory, "hypertok_wasm_core_bg.wasm"),
    path.join(browserWasmDirectory, "hypertok_wasm_core_bg.wasm"),
  );
  for (const artifact of vocabularyArtifacts) {
    const { browserAsset } = vocabularyRegistry.find(
      ({ id }) => id === artifact.vocabulary,
    );
    fs.copyFileSync(artifact.path, path.join(browserOutputDirectory, browserAsset));
  }

  const result = await build({
    absWorkingDir: benchesDirectory,
    entryPoints: [path.join(benchesDirectory, "browser", "entry.mjs")],
    outfile: path.join(browserOutputDirectory, "bundle.mjs"),
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "chrome150",
    conditions: ["browser", "import", "default"],
    nodePaths: [path.join(benchesDirectory, "node_modules")],
    legalComments: "none",
    metafile: true,
  });
  fs.writeFileSync(
    path.join(browserOutputDirectory, "bundle-meta.json"),
    `${JSON.stringify(result.metafile, null, 2)}\n`,
  );

  const tokenizerBinary = path.join(browserOutputDirectory, "gpt2-tokenizer.bin");
  fs.writeFileSync(tokenizerBinary, readBenchmarkTokenizer());
  const referenceDirectory = path.join(browserOutputDirectory, "references");
  const referenceResult = await build({
    absWorkingDir: benchesDirectory,
    entryPoints: Object.fromEntries(
      referenceSlugs.map((slug) => [
        slug,
        path.join(benchesDirectory, "browser", "references", `${slug}.mjs`),
      ]),
    ),
    outdir: referenceDirectory,
    entryNames: "[name]",
    outExtension: { ".js": ".mjs" },
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "chrome150",
    conditions: ["browser", "import", "default"],
    nodePaths: [path.join(benchesDirectory, "node_modules")],
    alias: {
      "benchmark-tokenizer-bytes": tokenizerBinary,
      "benchmark-hypertok-gpt2-htk": path.join(browserOutputDirectory, "gpt2.htk"),
      "benchmark-hypertok-o200k-htk": path.join(browserOutputDirectory, "o200k.htk"),
    },
    loader: { ".bin": "binary", ".htk": "binary", ".wasm": "binary" },
    legalComments: "none",
    metafile: true,
  });
  fs.writeFileSync(
    path.join(browserOutputDirectory, "reference-bundle-meta.json"),
    `${JSON.stringify(referenceResult.metafile, null, 2)}\n`,
  );
  for (const slug of referenceSlugs) {
    const bundlePath = path.join(referenceDirectory, `${slug}.mjs`);
    fs.writeFileSync(
      `${bundlePath}.gz`,
      gzipSync(fs.readFileSync(bundlePath), {
        level: 9,
        strategy: zlibConstants.Z_DEFAULT_STRATEGY,
      }),
    );
  }
  return browserOutputDirectory;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await buildBrowserBundle();
  console.log(browserOutputDirectory);
}
