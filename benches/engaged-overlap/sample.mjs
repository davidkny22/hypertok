import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Worker as NodeWorker } from "node:worker_threads";
import { pathToFileURL } from "node:url";

const [runtimePath, vocabularyPath, inputPath, tier = "worker"] = process.argv.slice(2);
if (!runtimePath || !vocabularyPath || !inputPath || !["single", "worker"].includes(tier)) {
  throw new Error("usage: sample.mjs runtime vocabulary input [single|worker]");
}

const bootstrap = new URL("./node-worker-bootstrap.mjs", import.meta.url);
const workerStats = { calls: 0, entries: 0, inputBytes: 0 };
class BrowserWorkerHarness {
  constructor(target) {
    this.listeners = new Map();
    this.inner = new NodeWorker(bootstrap, {
      type: "module",
      workerData: { target: target.href },
    });
    this.inner.on("message", (data) => this.dispatch("message", { data }));
    this.inner.on("error", (error) => this.dispatch("error", error));
  }

  addEventListener(type, listener) {
    const current = this.listeners.get(type) ?? [];
    current.push(listener);
    this.listeners.set(type, current);
  }

  removeEventListener(type, listener) {
    const current = this.listeners.get(type) ?? [];
    this.listeners.set(type, current.filter((candidate) => candidate !== listener));
  }

  dispatch(type, event) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  postMessage(value, transfer = []) {
    if (value?.operation === "encodePretokens") {
      const ranges = new Uint32Array(value.ranges);
      workerStats.calls += 1;
      workerStats.entries += ranges.length / 2;
      workerStats.inputBytes += value.input.byteLength;
    }
    this.inner.postMessage(value, transfer);
  }

  terminate() {
    return this.inner.terminate();
  }
}

globalThis.Worker = BrowserWorkerHarness;
Object.defineProperty(globalThis, "crossOriginIsolated", {
  value: false,
  configurable: true,
});

const runtime = await import(pathToFileURL(path.resolve(runtimePath)).href);
const vocabulary = new Uint8Array(fs.readFileSync(vocabularyPath));
const source = fs.readFileSync(inputPath);
const text = new TextDecoder("utf-8", { fatal: true }).decode(source);
const tokenizer = await runtime.fromBytes(vocabulary, { tier, workers: 2 });
let ids;
let milliseconds;
try {
  const started = performance.now();
  ids = tier === "worker" ? await tokenizer.encode(text) : tokenizer.encodeSync(text);
  milliseconds = performance.now() - started;
  if (tokenizer.decode(ids) !== text) throw new Error("public encode did not round-trip");
} finally {
  tokenizer.free();
}

if (tokenizer.tier !== tier) {
  throw new Error(`requested ${tier} tier but constructed ${tokenizer.tier}`);
}
if (tier === "worker" && (
  workerStats.calls <= 1 ||
  workerStats.entries <= 1 ||
  workerStats.inputBytes <= source.length
)) {
  throw new Error(`worker overlap did not engage: ${JSON.stringify(workerStats)}`);
}
if (tier === "single" && Object.values(workerStats).some((value) => value !== 0)) {
  throw new Error(`single tier dispatched worker work: ${JSON.stringify(workerStats)}`);
}

const idDigest = crypto.createHash("sha256")
  .update(Buffer.from(ids.buffer, ids.byteOffset, ids.byteLength))
  .digest("hex");
process.stdout.write(`${JSON.stringify({
  milliseconds,
  inputBytes: source.length,
  idDigest,
  tokenCount: ids.length,
  vocabSize: tokenizer.vocabSize,
  tier,
  workerStats,
})}\n`);
