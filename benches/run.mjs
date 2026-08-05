import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const benchesDirectory = path.dirname(fileURLToPath(import.meta.url));
const testFiles = Object.freeze([
  "tests/verify_public_contracts.mjs",
  "tests/verify_output.mjs",
  "tests/verify_browser_control.mjs",
  "tests/verify_browser_memory.mjs",
  "tests/verify_browser_server.mjs",
  "tests/verify_runner.mjs",
  "tests/verify_gpt2_model.mjs",
  "tests/verify_corpus.mjs",
  "tests/verify_node_adapters.mjs",
  "tests/verify_browser_adapters.mjs",
  "tests/verify_decode_throughput.mjs",
  "tests/verify_decode_artifact_pricing.mjs",
  "tests/verify_verdict_sampling.mjs",
  "tests/verify_harness_self_check_node.mjs",
  "tests/verify_harness_self_check_browser.mjs",
  "tests/verify_harness_self_check_cross_env.mjs",
  "tests/verify_agreement.mjs",
  "tests/verify_browser_agreement.mjs",
  "tests/verify_agreement_cross_env.mjs",
  "tests/verify_reference_payloads_node.mjs",
  "tests/verify_reference_payloads.mjs",
]);
const benchmarkFiles = Object.freeze([
  "tests/verify_gpt2_model.mjs",
  "tests/verify_corpus.mjs",
  "tests/verify_harness_self_check_node.mjs",
  "tests/verify_harness_self_check_browser.mjs",
  "tests/verify_harness_self_check_cross_env.mjs",
  "tests/verify_agreement.mjs",
  "tests/verify_browser_agreement.mjs",
  "tests/verify_agreement_cross_env.mjs",
  "measure_node_throughput.mjs",
  "measure_browser_throughput.mjs",
  "measure_node_decode.mjs",
  "measure_browser_decode.mjs",
]);
const carriedForwardArenaAxes = Object.freeze([
  "transfer",
  "decompression",
  "materialisation",
  "memory",
]);
const shippingFiles = Object.freeze([
  "script-measurement/run.mjs",
  "measure_shim_overhead.mjs",
]);

function option(args, name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  if (index + 1 >= args.length || args[index + 1].startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return args[index + 1];
}

function commandPlan(args) {
  const command = args[0];
  if (command === "test") {
    return { command, profile: null, mode: null, files: testFiles };
  }
  if (command !== "benchmark") {
    throw new Error(
      "Usage: node run.mjs test | benchmark --profile arena|shipping --mode smoke|full [--chrome <path>] [--source-ranks <path>]",
    );
  }
  const profile = option(args, "--profile", "arena");
  if (!["arena", "shipping"].includes(profile)) {
    throw new Error(`Unknown benchmark profile: ${profile}`);
  }
  const mode = option(args, "--mode", "full");
  if (!["smoke", "full"].includes(mode)) {
    throw new Error(`Unknown benchmark mode: ${mode}`);
  }
  return {
    command,
    profile,
    mode,
    files: profile === "arena" ? benchmarkFiles : shippingFiles,
    carriedForwardAxes: profile === "arena" ? carriedForwardArenaAxes : [],
  };
}

const args = process.argv.slice(2);
const plan = commandPlan(args);
if (args.includes("--list")) {
  console.log(JSON.stringify(plan));
  process.exit(0);
}

const environment = { ...process.env };
const chrome = option(args, "--chrome", null);
if (chrome !== null) environment.HYPERTOK_CHROME_PATH = chrome;
if (plan.command === "benchmark") {
  environment.HYPERTOK_BENCH_PROFILE = plan.profile;
  environment.HYPERTOK_BENCH_MODE = plan.mode;
  environment.HYPERTOK_RUN_SESSION =
    environment.HYPERTOK_RUN_SESSION ?? new Date().toISOString().replaceAll(":", "-");
  console.log(`run session: ${environment.HYPERTOK_RUN_SESSION}`);
  if (plan.profile === "shipping") {
    const sourceRanks = option(
      args,
      "--source-ranks",
      environment.HYPERTOK_SOURCE_RANKS ?? null,
    );
    if (sourceRanks === null || sourceRanks.length === 0) {
      throw new Error("The shipping profile requires --source-ranks <path>");
    }
    environment.HYPERTOK_SOURCE_RANKS = path.resolve(sourceRanks);
    const htkPath = option(args, "--htk", environment.HYPERTOK_HTK_PATH ?? null);
    if (htkPath !== null) environment.HYPERTOK_HTK_PATH = path.resolve(htkPath);
  }
  if (plan.mode === "smoke") {
    environment.HYPERTOK_BENCH_N = "1";
    environment.HYPERTOK_BENCH_MAX_N = "1";
    environment.HYPERTOK_BENCH_OPENWEBTEXT_N = "1";
    environment.HYPERTOK_BENCH_WARMUP = "0";
    environment.HYPERTOK_BENCH_TARGET_BYTES = "1024";
    environment.HYPERTOK_LOAD_N = "1";
    environment.HYPERTOK_MEMORY_N = "1";
    environment.HYPERTOK_SCRIPT_N = "1";
    environment.HYPERTOK_SCRIPT_WARMUP = "0";
    environment.HYPERTOK_SCRIPT_TARGET_BYTES = "1024";
  }
  if (plan.carriedForwardAxes.length > 0) {
    console.log(`carried-forward axes: ${plan.carriedForwardAxes.join(", ")}`);
  }
}

for (const file of plan.files) {
  console.log(`> node ${file}`);
  const result = spawnSync(process.execPath, [file], {
    cwd: benchesDirectory,
    env: environment,
    stdio: "inherit",
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log(
  `${plan.command} ${plan.profile ?? "checks"} ${plan.mode ?? "full"} PASS (${plan.files.length}/${plan.files.length} commands)`,
);
