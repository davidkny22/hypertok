#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

function parseArgs(argv) {
  const values = {};
  for (const argument of argv) {
    if (!argument.startsWith("--")) throw new Error(`unexpected argument: ${argument}`);
    const separator = argument.indexOf("=");
    const key = argument.slice(2, separator === -1 ? undefined : separator);
    const value = separator === -1 ? true : argument.slice(separator + 1);
    if (key === "vocab") (values.vocab ??= []).push(value);
    else values[key] = value;
  }
  return values;
}

function exact(value, unit = "bytes") {
  return { value, unit, noise: { kind: "deterministic", absolute: 0, relative: 0 } };
}

function resolveExport(packageJson, key) {
  const target = packageJson.exports?.[key];
  if (typeof target === "string") return target;
  if (target && typeof target === "object") return target.import ?? target.default;
  throw new Error(`package export ${key} is unavailable`);
}

function staticImports(source) {
  const matches = [];
  const patterns = [
    /(?:import|export)\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']/g,
    /import\s*["']([^"']+)["']/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) matches.push(match[1]);
  }
  return matches;
}

function crawlStaticFiles(entry) {
  const pending = [entry];
  const found = new Set();
  while (pending.length > 0) {
    const current = path.resolve(pending.pop());
    if (found.has(current)) continue;
    found.add(current);
    const source = fs.readFileSync(current, "utf8");
    for (const specifier of staticImports(source)) {
      if (!specifier.startsWith(".")) continue;
      let resolved = path.resolve(path.dirname(current), specifier);
      if (!path.extname(resolved)) resolved += ".mjs";
      if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) pending.push(resolved);
    }
  }
  return found;
}

function allFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  const output = [];
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const resolved = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(resolved);
      else if (entry.isFile()) output.push(resolved);
    }
  }
  return output;
}

function compressionRows(scope, files, packageRoot, gzipLevel, brotliQuality) {
  const rows = [];
  const totals = { identity: 0, gzip: 0, brotli: 0 };
  for (const file of [...new Set(files.map((value) => path.resolve(value)))].sort()) {
    const bytes = fs.readFileSync(file);
    const values = {
      identity: bytes.length,
      gzip: gzipSync(bytes, { level: gzipLevel }).length,
      brotli: brotliCompressSync(bytes, {
        params: { [constants.BROTLI_PARAM_QUALITY]: brotliQuality },
      }).length,
    };
    for (const [basis, value] of Object.entries(values)) {
      totals[basis] += value;
      rows.push({
        id: `${scope}-${basis}-${path.relative(packageRoot, file).replaceAll("\\", "/")}`,
        status: "measured",
        parameters: { scope, basis, file: path.relative(packageRoot, file).replaceAll("\\", "/") },
        result: exact(value),
      });
    }
  }
  for (const [basis, value] of Object.entries(totals)) {
    rows.push({
      id: `${scope}-${basis}-total`,
      status: "measured",
      parameters: { scope, basis, fileCount: files.length },
      result: exact(value),
    });
  }
  return rows;
}

const parameters = parseArgs(process.argv.slice(2));
const gzipLevel = Number(parameters["gzip-level"] ?? 9);
const brotliQuality = Number(parameters["brotli-quality"] ?? 11);
const packageRoot = path.resolve(String(parameters["package-root"] ?? "node_modules/hypertok"));
const assumptions = [
  "The runtime package root is an installed package tree, and its package.json export map defines the public entry.",
  "Compression is applied independently to each shipped file, matching separate HTTP resources rather than a concatenated archive.",
  "The single artifact loads on every tier; adapter shim entry points are excluded, while shim-runtime remains a loader dependency.",
  "Vocabulary cells use the shipped vocabulary file supplied on argv, not a live CDN response.",
];
const limits = [
  "Static JavaScript membership is resolved from relative static imports plus the named tier loader files; computed imports outside that graph must be supplied by the installed package layout.",
  "Live CDN sizes are cross-checks and are not booked by this instrument.",
  "Byte counts are deterministic and therefore exempt from sampling.",
];

let cells = [];
if (parameters.smoke) {
  cells = [{
    id: "smoke",
    status: "not-booked",
    parameters: { gzipLevel, brotliQuality },
    result: null,
    noise: null,
  }];
} else {
  const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  const publicEntry = path.resolve(packageRoot, resolveExport(packageJson, "."));
  const staticFiles = crawlStaticFiles(publicEntry);
  staticFiles.add(path.join(packageRoot, "src", "tier-worker.mjs"));
  staticFiles.add(path.join(packageRoot, "src", "shim-runtime.mjs"));
  const singleFiles = [
    ...staticFiles,
    ...allFiles(path.join(packageRoot, "wasm", "single")),
  ];
  const sharedFiles = [
    ...singleFiles,
    path.join(packageRoot, "src", "shared-controller.mjs"),
    ...allFiles(path.join(packageRoot, "wasm", "shared")),
  ];
  cells.push(...compressionRows("engine-single", singleFiles, packageRoot, gzipLevel, brotliQuality));
  cells.push(...compressionRows("engine-shared", sharedFiles, packageRoot, gzipLevel, brotliQuality));
  for (const [index, value] of (parameters.vocab ?? []).entries()) {
    const pieces = String(value).split("|");
    const file = path.resolve(pieces.length > 1 ? pieces[1] : pieces[0]);
    const label = pieces.length > 1 ? pieces[0] : path.basename(path.dirname(file));
    const format = pieces[2] ?? "htk";
    cells.push(...compressionRows(`vocab-${label}-${format}`, [file], path.dirname(file), gzipLevel, brotliQuality));
    if (index === 0 && !fs.existsSync(file)) throw new Error(`vocabulary file not found: ${file}`);
  }
}

for (const cell of cells) {
  cell.assumptions = assumptions;
  cell.limits = limits;
}

process.stdout.write(`${JSON.stringify({
  schemaVersion: 1,
  instrument: 4,
  subject: "compressed artifact bytes",
  axes: [6, 7],
  mode: parameters.smoke ? "smoke" : "measure",
  parameters: { ...parameters, gzipLevel, brotliQuality, packageRoot },
  cells,
  assumptions,
  limits,
}, null, 2)}\n`);
