#!/usr/bin/env node

function parseArgs(argv) {
  const values = {};
  for (const argument of argv) {
    if (!argument.startsWith("--")) throw new Error(`unexpected argument: ${argument}`);
    const separator = argument.indexOf("=");
    const key = argument.slice(2, separator === -1 ? undefined : separator);
    const value = separator === -1 ? true : argument.slice(separator + 1);
    values[key] = value;
  }
  return values;
}

const parameters = parseArgs(process.argv.slice(2));
const requestedTiers = String(parameters.tiers ?? "worker,shared")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

const assumptions = [
  "Resident memory is the process RSS delta attributable to constructed tokenizers at a stated resident-tokenizer and worker count.",
  "Shared-pool structures count once against the pool.",
  "Worker and shared construction must use the installed package's public fromBytes entry point in a browser host.",
];
const limits = [
  "No qualified browser process-memory seam exists, so worker and shared resident-memory cells are blocked.",
  "Node cannot construct the worker and shared browser tiers through the public package surface.",
  "This script does not substitute JavaScript heap estimates, wasm page counts, or private runtime counters for browser RSS.",
];

const cells = requestedTiers.map((tier) => ({
  id: `resident-memory-${tier}`,
  status: "blocked",
  parameters: {
    tier,
    runtime: parameters.runtime ?? "browser",
    vocabulary: parameters.vocabulary ?? null,
    tokenizerCount: Number(parameters.tokenizers ?? 1),
    workers: Number(parameters.workers ?? 1),
  },
  result: null,
  noise: null,
  blocked: {
    reason: "browser-memory-seam-unqualified",
    needed: "A browser API or host probe that reports process RSS through the public deployment environment.",
  },
  assumptions,
  limits,
}));

process.stdout.write(`${JSON.stringify({
  schemaVersion: 1,
  instrument: 13,
  subject: "tiered resident memory",
  axes: [8],
  mode: parameters.smoke ? "smoke" : "measure",
  parameters,
  cells,
  assumptions,
  limits,
}, null, 2)}\n`);
