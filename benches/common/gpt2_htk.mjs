import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  benchmarkTokenizerPath,
  benchmarkTokenizerSha256,
} from "./gpt2_model.mjs";

const benchesDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryDirectory = path.resolve(benchesDirectory, "..");
const outputDirectory = path.join(repositoryDirectory, "results", "harness", "gpt2-htk");
export const benchmarkHtkPath = path.join(outputDirectory, "gpt2.htk");

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

export function buildBenchmarkHtk() {
  fs.mkdirSync(outputDirectory, { recursive: true });
  const result = spawnSync(
    "cargo",
    [
      "run",
      "--locked",
      "--release",
      "--offline",
      "--manifest-path",
      "hypertok-converter/Cargo.toml",
      "--example",
      "tokenizer_json",
      "--",
      benchmarkTokenizerPath,
      benchmarkTokenizerSha256,
      benchmarkHtkPath,
    ],
    { cwd: repositoryDirectory, encoding: "utf8", stdio: "pipe" },
  );
  if (result.status !== 0) {
    throw new Error(
      [
        `GPT-2 HTK conversion failed with status ${result.status}`,
        result.stdout,
        result.stderr,
      ].filter(Boolean).join("\n"),
    );
  }
  const bytes = fs.readFileSync(benchmarkHtkPath);
  return Object.freeze({
    bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    path: benchmarkHtkPath,
    sourceSha256: benchmarkTokenizerSha256,
    sha256: sha256(bytes),
  });
}
