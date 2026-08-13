#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { brotliCompressSync, constants } from "node:zlib";

function parseArgs(argv) {
  const values = {};
  for (const argument of argv) {
    if (!argument.startsWith("--")) throw new Error(`unexpected argument: ${argument}`);
    const separator = argument.indexOf("=");
    const key = argument.slice(2, separator === -1 ? undefined : separator);
    const value = separator === -1 ? true : argument.slice(separator + 1);
    if (key === "wasm") (values.wasm ??= []).push(value);
    else values[key] = value;
  }
  return values;
}

function exact(value, unit = "bytes") {
  return { value, unit, noise: { kind: "deterministic", absolute: 0, relative: 0 } };
}

function readUleb(bytes, start) {
  let value = 0;
  let shift = 0;
  let cursor = start;
  while (cursor < bytes.length) {
    const byte = bytes[cursor++];
    value += (byte & 0x7f) * (2 ** shift);
    if ((byte & 0x80) === 0) return { value, cursor };
    shift += 7;
    if (shift > 49) throw new Error("wasm section length exceeds exact JavaScript integer range");
  }
  throw new Error("truncated wasm section length");
}

function sectionCensus(bytes) {
  if (bytes.length < 8 || bytes.subarray(0, 4).toString("hex") !== "0061736d") {
    throw new Error("input is not a WebAssembly binary");
  }
  const names = ["custom", "type", "import", "function", "table", "memory", "global", "export", "start", "element", "code", "data", "data-count", "tag"];
  const rows = [{ name: "header", id: null, offset: 0, bytes: 8 }];
  let cursor = 8;
  while (cursor < bytes.length) {
    const start = cursor;
    const id = bytes[cursor++];
    const length = readUleb(bytes, cursor);
    cursor = length.cursor + length.value;
    if (cursor > bytes.length) throw new Error("wasm section extends beyond the file");
    rows.push({ name: names[id] ?? `unknown-${id}`, id, offset: start, bytes: cursor - start });
  }
  return rows;
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", windowsHide: true });
  return {
    ok: result.status === 0,
    command: [command, ...args],
    stdout: result.stdout?.trim() ?? "",
    stderr: result.stderr?.trim() ?? "",
    exitCode: result.status,
    error: result.error?.message ?? null,
  };
}

function twiggyCell(id, command, args, cwd, parameters) {
  const receipt = run(command, args, cwd);
  return {
    id,
    status: receipt.ok ? "measured" : "blocked",
    parameters,
    result: receipt.ok ? { report: receipt.stdout, noise: { kind: "deterministic" } } : null,
    noise: receipt.ok ? { kind: "deterministic", absolute: 0, relative: 0 } : null,
    blocked: receipt.ok ? undefined : {
      reason: "twiggy-unavailable-or-refused-input",
      needed: receipt.error ?? receipt.stderr,
    },
    command: receipt.command,
  };
}

function brotliSet(files, quality) {
  return files.reduce((total, file) => total + brotliCompressSync(fs.readFileSync(file), {
    params: { [constants.BROTLI_PARAM_QUALITY]: quality },
  }).length, 0);
}

function buildVariant(definition, quality, root) {
  const receipt = run(definition.command, definition.args ?? [], definition.cwd ? path.resolve(root, definition.cwd) : root);
  if (!receipt.ok) throw new Error(`ablation build ${definition.name} failed: ${receipt.stderr || receipt.error}`);
  const files = definition.artifacts.map((file) => path.resolve(root, file));
  return { receipt, bytes: brotliSet(files, quality), files };
}

const parameters = parseArgs(process.argv.slice(2));
const selectedLayer = String(parameters.layer ?? "read-only");
const twiggy = String(parameters.twiggy ?? "twiggy");
const assumptions = [
  "Section bytes are read directly from the shipped wasm binary, including each section id and length prefix.",
  "Twiggy top and dominator reports attribute functions and crate-owned subtrees; twiggy garbage identifies unreachable items.",
  "WebAssembly exports are the root inventory, and every exported item is treated as retained capability.",
  "Feature-ablation Brotli deltas are ranked only and are not added together.",
  "The closure floor is one directly measured required-capability build whose capability list is owner input recorded beside the cell.",
];
const limits = [
  "The closure floor is a design attribution bound, not a physical lower bound.",
  "Layer 3 performs roughly fifteen builds and must run only under a separately authorized machine booking.",
  "Layers 1 and 2 are deterministic and exempt from sampling.",
  "A missing twiggy executable blocks function, crate, garbage, and dominator attribution without blocking the direct section or export census.",
];

const cells = [];
if (parameters.smoke) {
  cells.push({ id: "smoke", status: "not-booked", parameters: { selectedLayer }, result: null, noise: null });
} else {
  const wasmSpecs = parameters.wasm ?? [];
  if (wasmSpecs.length === 0) throw new Error("at least one --wasm=<label>|<path>|<build-target> is required");
  for (const specification of wasmSpecs) {
    const [label, fileValue, buildTarget = "unspecified"] = String(specification).split("|");
    const file = path.resolve(fileValue ?? label);
    const bytes = fs.readFileSync(file);
    for (const section of sectionCensus(bytes)) {
      cells.push({
        id: `${label}-section-${section.name}-${section.offset}`,
        status: "measured",
        parameters: { label, buildTarget, file, section: section.name, sectionId: section.id, offset: section.offset },
        result: exact(section.bytes),
      });
    }
    const exports = WebAssembly.Module.exports(new WebAssembly.Module(bytes));
    cells.push({
      id: `${label}-export-roots`,
      status: "measured",
      parameters: { label, buildTarget, file },
      result: { exports, count: exact(exports.length, "items") },
    });
    const cwd = path.dirname(file);
    cells.push(twiggyCell(`${label}-function-and-crate-census`, twiggy, ["top", "-n", "200", file], cwd, { label, buildTarget, file }));
    cells.push(twiggyCell(`${label}-dominator-tree`, twiggy, ["dominators", file], cwd, { label, buildTarget, file }));
    cells.push(twiggyCell(`${label}-garbage`, twiggy, ["garbage", file], cwd, { label, buildTarget, file }));
  }

  if (selectedLayer === "3" || selectedLayer === "all") {
    if (!parameters["ablation-manifest"]) throw new Error("layer 3 requires --ablation-manifest=<json>");
    const manifestPath = path.resolve(String(parameters["ablation-manifest"]));
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const root = path.dirname(manifestPath);
    const quality = Number(manifest.brotliQuality ?? parameters["brotli-quality"] ?? 11);
    if (!Array.isArray(manifest.features) || manifest.features.length !== 15) {
      throw new Error("the full ablation manifest must contain exactly fifteen feature builds");
    }
    const baseline = buildVariant({ name: "baseline", ...manifest.baseline }, quality, root);
    for (const feature of manifest.features) {
      const built = buildVariant(feature, quality, root);
      cells.push({
        id: `feature-ablation-${feature.name}`,
        status: "measured",
        parameters: { feature: feature.name, buildTarget: feature.buildTarget, brotliQuality: quality },
        result: {
          variantBytes: exact(built.bytes),
          baselineBytes: exact(baseline.bytes),
          deltaBytes: exact(built.bytes - baseline.bytes),
        },
      });
    }
    if (manifest.floor) {
      const floor = buildVariant({ name: "required-closure", ...manifest.floor }, quality, root);
      cells.push({
        id: "required-closure-floor",
        status: "measured",
        parameters: {
          buildTarget: manifest.floor.buildTarget,
          capabilities: manifest.floor.capabilities ?? [],
          brotliQuality: quality,
        },
        result: { compressedBytes: exact(floor.bytes) },
      });
    } else {
      cells.push({
        id: "required-closure-floor",
        status: "blocked",
        parameters: {},
        result: null,
        noise: null,
        blocked: { reason: "owner-capability-list-missing", needed: "A floor build and owner-supplied required capability list in the ablation manifest." },
      });
    }
  } else {
    cells.push({
      id: "feature-ablation-matrix",
      status: "deferred",
      parameters: { requestedLayer: selectedLayer },
      result: null,
      noise: null,
      blocked: { reason: "machine-heavy-layer-not-run", needed: "A separately authorized machine booking and a complete ablation manifest." },
    });
  }
}

for (const cell of cells) {
  cell.assumptions = assumptions;
  cell.limits = limits;
}

process.stdout.write(`${JSON.stringify({
  schemaVersion: 1,
  instrument: 3,
  subject: "wasm section census and floor evidence",
  axes: [6],
  mode: parameters.smoke ? "smoke" : "measure",
  parameters: { ...parameters, selectedLayer },
  cells,
  assumptions,
  limits,
}, null, 2)}\n`);
