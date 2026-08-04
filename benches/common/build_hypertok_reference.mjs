import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const benchesDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repository = path.resolve(benchesDirectory, "..");
const output = path.join(repository, "results", "harness", "hypertok-reference");
const target = path.join(output, "target");
const binding = path.join(output, "binding");

function run(command, arguments_) {
  const result = spawnSync(command, arguments_, {
    cwd: repository,
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.status !== 0) {
    throw new Error(
      [
        `${command} ${arguments_.join(" ")} failed with status ${result.status}`,
        result.stdout,
        result.stderr,
      ].filter(Boolean).join("\n"),
    );
  }
}

export function buildHypertokReference() {
  fs.mkdirSync(binding, { recursive: true });
  run("cargo", [
    "build",
    "--locked",
    "--target",
    "wasm32-unknown-unknown",
    "--release",
    "--no-default-features",
    "--features",
    "portable-json,wasm-binding,htk,sentencepiece-core,source-loaders,opt-decode-assembly",
    "--target-dir",
    target,
  ]);
  run("wasm-bindgen", [
    path.join(target, "wasm32-unknown-unknown", "release", "hypertok.wasm"),
    "--out-dir",
    binding,
    "--target",
    "web",
    "--no-typescript",
    "--out-name",
    "hypertok_wasm_core",
  ]);
  return binding;
}
