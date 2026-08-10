import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.resolve(packageRoot, "..");
const resultParent = path.join(root, "results", "phase6", "core-package");
mkdirSync(resultParent, { recursive: true });
const gateRoot = mkdtempSync(path.join(resultParent, "run-"));
const packDirectory = path.join(gateRoot, "pack");
const installDirectory = path.join(gateRoot, "install");
mkdirSync(packDirectory);
mkdirSync(installDirectory);

const npmCandidates = [
  process.env.npm_execpath,
  path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
  path.join(process.env.APPDATA ?? tmpdir(), "npm", "node_modules", "npm", "bin", "npm-cli.js"),
].filter(Boolean);
const npmCli = npmCandidates.find((candidate) => existsSync(candidate));
assert.ok(npmCli, `npm CLI was not found in: ${npmCandidates.join(", ")}`);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    env: {
      ...process.env,
      NO_UPDATE_NOTIFIER: "1",
      npm_config_cache: path.join(gateRoot, "npm-cache"),
    },
  });
  if (result.status !== 0) {
    throw new Error(
      [
        `${path.basename(command)} ${args.join(" ")} failed with status ${result.status}`,
        result.stdout,
        result.stderr,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  return result.stdout.trim();
}

const packOutput = run(process.execPath, [
  npmCli,
  "pack",
  packageRoot,
  "--pack-destination",
  packDirectory,
  "--json",
]);
const packed = JSON.parse(packOutput);
assert.equal(packed.length, 1);
const manifest = packed[0];
const vocabPackOutput = run(process.execPath, [
  npmCli,
  "pack",
  path.join(root, "hypertok-vocab", "o200k"),
  "--pack-destination",
  packDirectory,
  "--json",
]);
const vocabPacked = JSON.parse(vocabPackOutput);
assert.equal(vocabPacked.length, 1);
const vocabManifest = vocabPacked[0];
const packedPaths = new Set(manifest.files.map((entry) => entry.path.replaceAll("\\", "/")));
assert.equal(
  [...packedPaths].filter((entry) => entry.startsWith("tests/") || entry.startsWith("results/")).length,
  0,
  "test or result files entered the packed package",
);

writeFileSync(
  path.join(installDirectory, "package.json"),
  `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`,
);
const tarball = path.join(packDirectory, manifest.filename);
const vocabTarball = path.join(packDirectory, vocabManifest.filename);
run(
  process.execPath,
  [
    npmCli,
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--package-lock=false",
    tarball,
    vocabTarball,
  ],
  { cwd: installDirectory },
);

const smokePath = path.join(installDirectory, "smoke.mjs");
writeFileSync(
  smokePath,
  `import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fromBytes } from "hypertok";
import { createTiktokenShim } from "hypertok/tiktoken";
import { createHuggingFaceShim } from "hypertok/huggingface";
import { createLazyHuggingFaceShim } from "hypertok/huggingface-lazy";
import { createVocabLoader, loadVocab, VocabIntegrityError } from "hypertok/vocab-resolve";

const byteBytes = await readFile(process.argv[2]);
assert.deepEqual(await loadVocab("o200k"), byteBytes);
const expectedVocabBytes = new Uint8Array(byteBytes);
const fallback = createVocabLoader({
  readLocal: async () => { throw new Error("filesystem unavailable"); },
  fetch: async () => ({
    ok: true,
    arrayBuffer: async () => byteBytes.buffer.slice(
      byteBytes.byteOffset,
      byteBytes.byteOffset + byteBytes.byteLength,
    ),
  }),
});
assert.deepEqual(await fallback("o200k"), expectedVocabBytes);
const tamperedVocabBytes = new Uint8Array(byteBytes);
tamperedVocabBytes[tamperedVocabBytes.length - 1] ^= 1;
const tamperedFallback = createVocabLoader({
  readLocal: async () => { throw new Error("filesystem unavailable"); },
  fetch: async () => ({ ok: true, arrayBuffer: async () => tamperedVocabBytes.buffer }),
});
await assert.rejects(
  () => tamperedFallback("o200k"),
  (error) => error instanceof VocabIntegrityError
    && error.code === "ERR_HYPERTOK_VOCAB_INTEGRITY",
);
const wasmBytes = await readFile(
  new URL(import.meta.resolve("hypertok/wasm/single/hypertok_wasm_core_bg.wasm")),
);
const byteTokenizer = await fromBytes(byteBytes, { tier: "single", moduleSource: wasmBytes });
const byteDetailed = await byteTokenizer.encodeDetailed("hello world");
assert.equal(byteTokenizer.structuralClass, "byte_bpe");
assert.equal(byteTokenizer.decode(byteDetailed.ids), "hello world");
assert.equal(byteDetailed.starts.length, byteDetailed.ids.length);
byteTokenizer.free();

const tiktokenHandle = await fromBytes(byteBytes, { tier: "single" });
const tiktoken = createTiktokenShim(tiktokenHandle, { name: "o200k_base" });
const tiktokenIds = tiktoken.encode_ordinary("hello world");
assert.equal(new TextDecoder().decode(tiktoken.decode(tiktokenIds)), "hello world");
tiktoken.free();

function huggingFaceSetup(handle) {
  const decoder = new TextDecoder();
  return {
    tokenString: (id) => decoder.decode(handle.tokenBytes(id)),
    postProcess: (first) => ({ ids: first }),
    specialTokens: [],
    unknownTokenId: 0,
    cleanUpTokenizationSpaces: false,
  };
}

const huggingFaceHandle = await fromBytes(byteBytes, { tier: "single" });
const huggingFace = createHuggingFaceShim(
  huggingFaceHandle,
  huggingFaceSetup(huggingFaceHandle),
);
const huggingFaceEncoding = huggingFace.encode("hello world");
assert.equal(huggingFace.decode(huggingFaceEncoding.ids), "hello world");
huggingFace.free();

const lazyHandle = await fromBytes(byteBytes, { tier: "single" });
const lazyHuggingFace = createLazyHuggingFaceShim(lazyHandle, huggingFaceSetup(lazyHandle));
const lazyEncoding = lazyHuggingFace.encode("hello world");
assert.equal(lazyHuggingFace.decode(lazyEncoding.ids), "hello world");
lazyHuggingFace.free();

const sentencePieceBytes = await readFile(process.argv[3]);
const sentencePiece = await fromBytes(sentencePieceBytes, { tier: "single" });
const sentencePieceDetailed = await sentencePiece.encodeDetailed("ab");
assert.equal(sentencePiece.structuralClass, "sentencepiece_bpe");
assert.deepEqual(Array.from(sentencePiece.prefixMarker), [259]);
assert.deepEqual(Array.from(sentencePieceDetailed.ids), [258]);
assert.deepEqual(Array.from(sentencePieceDetailed.starts), [0]);
assert.equal(sentencePiece.decode(sentencePieceDetailed.ids), "ab");
sentencePiece.free();

console.log(JSON.stringify({
  byteIds: byteDetailed.ids.length,
  tiktokenIds: tiktokenIds.length,
  huggingFaceIds: huggingFaceEncoding.ids.length,
  lazyHuggingFaceIds: lazyEncoding.ids.length,
  sentencePieceIds: sentencePieceDetailed.ids.length,
  sentencePieceStarts: Array.from(sentencePieceDetailed.starts),
}));
`,
);
const smokeOutput = run(
  process.execPath,
  [
    smokePath,
    path.join(root, "hypertok-vocab", "o200k", "vocab.htk"),
    path.join(root, "tests", "fixtures", "sentencepiece.htk"),
  ],
  { cwd: installDirectory },
);
const smoke = JSON.parse(smokeOutput);

console.log(
  JSON.stringify(
    {
      gateRoot,
      tarball: manifest.filename,
      packedFiles: manifest.files.length,
      packedBytes: manifest.size,
      unpackedBytes: manifest.unpackedSize,
      installedPackage: readFileSync(
        path.join(installDirectory, "node_modules", "hypertok", "package.json"),
        "utf8",
      ).length > 0,
      smoke,
    },
    null,
    2,
  ),
);
