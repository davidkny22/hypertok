import assert from "node:assert/strict";
import childProcess from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const features = [
  "portable-json",
  "wasm-binding",
  "htk",
  "sentencepiece-core",
  "opt-marshalling",
  "opt-chunk-prescan",
  "opt-scan-two-phase",
  "opt-level-select",
  "opt-cold-diet",
  "opt-fused-pair-ranks",
  "opt-decode-assembly",
  "opt-decode-borrowed-output",
  "opt-decode-utf16-output",
  "opt-force-split-bigram",
  "opt-scratch-reuse",
];

const result = childProcess.spawnSync(
  "cargo",
  [
    "check",
    "--locked",
    "--lib",
    "--target",
    "wasm32-unknown-unknown",
    "--no-default-features",
    "--features",
    features.join(","),
  ],
  { cwd: repository, encoding: "utf8", windowsHide: true },
);

assert.equal(
  result.status,
  0,
  `scratch, level selection, and chunk prescan must compile together\n${result.stdout}\n${result.stderr}`,
);
console.log(JSON.stringify({ pass: true, features: features.length }));
