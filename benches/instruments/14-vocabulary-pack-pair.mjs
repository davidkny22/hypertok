#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

function parseArgs(argv) {
  const values = {};
  for (const argument of argv) {
    if (!argument.startsWith("--")) throw new Error(`unexpected argument: ${argument}`);
    const separator = argument.indexOf("=");
    const key = argument.slice(2, separator === -1 ? undefined : separator);
    const value = separator === -1 ? true : argument.slice(separator + 1);
    if (key === "package") (values.package ??= []).push(value);
    else values[key] = value;
  }
  return values;
}

function exact(value) {
  return { value, unit: "bytes", noise: { kind: "deterministic", absolute: 0, relative: 0 } };
}

function treeBytes(root) {
  let bytes = 0;
  let files = 0;
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const resolved = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(resolved);
      else if (entry.isFile()) {
        bytes += fs.statSync(resolved).size;
        files += 1;
      }
    }
  }
  return { bytes, files };
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

function packageCell(specification, environment, cacheState) {
  const prefix = fs.mkdtempSync(path.join(os.tmpdir(), "hypertok-vocab-pack-"));
  try {
    const installArgs = [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      "--prefix",
      prefix,
    ];
    if (cacheState === "cold") installArgs.push("--prefer-online");
    if (cacheState === "warm") installArgs.push("--prefer-offline");
    installArgs.push(specification);
    run(environment.command, installArgs, prefix);
    const installed = treeBytes(path.join(prefix, "node_modules"));
    const packOutput = run(
      environment.command,
      ["pack", "--json", "--ignore-scripts", "--pack-destination", prefix, specification],
      prefix,
    );
    const packRows = JSON.parse(packOutput);
    if (!Array.isArray(packRows) || packRows.length !== 1) {
      throw new Error("npm pack did not report exactly one tarball");
    }
    const packed = fs.statSync(path.join(prefix, packRows[0].filename)).size;
    return {
      id: `vocabulary-pack-${specification}`,
      status: "measured",
      parameters: {
        package: specification,
        packageManager: environment.name,
        registryOrLink: environment.source,
        cacheState,
        installedFileCount: installed.files,
      },
      result: {
        unpackedTree: exact(installed.bytes),
        packedTarball: exact(packed),
      },
    };
  } finally {
    fs.rmSync(prefix, { recursive: true, force: true });
  }
}

const parameters = parseArgs(process.argv.slice(2));
const packageManager = String(parameters["package-manager"] ?? "npm");
const assumptions = [
  "Each cell installs one vocabulary package into a clean prefix for the stated install environment.",
  "The unpacked-tree reading includes every file under the clean prefix's node_modules tree, including transitive dependencies.",
  "The tarball reading is the exact npm pack artifact for the requested package specification.",
  "Package install scripts are disabled because shipped hypertok packages must not require them.",
];
const limits = [
  "Only npm is implemented; other package managers produce a blocked cell rather than a substituted method.",
  "Registry and linked-package cells are different install environments and must be booked separately.",
  "The npm cache state is declared as cold, warm, or ambient; this instrument does not erase a caller-owned cache.",
  "Byte counts are deterministic and therefore exempt from sampling.",
];

let cells;
if (parameters.smoke) {
  cells = [{ id: "smoke", status: "not-booked", parameters: {}, result: null, noise: null }];
} else if (packageManager !== "npm") {
  cells = [{
    id: `package-manager-${packageManager}`,
    status: "blocked",
    parameters: { packageManager },
    result: null,
    noise: null,
    blocked: { reason: "package-manager-unimplemented", needed: "An exact clean-prefix install and pack adapter for this package manager." },
  }];
} else {
  const packageSpecs = parameters.package ?? [];
  if (packageSpecs.length === 0) throw new Error("at least one --package=<specifier> is required");
  const source = String(parameters.source ?? "registry-or-link-as-specified");
  const cacheState = String(parameters.cache ?? "ambient");
  cells = packageSpecs.map((specification) => packageCell(
    String(specification),
    { name: "npm", command: process.platform === "win32" ? "npm.cmd" : "npm", source },
    cacheState,
  ));
}

for (const cell of cells) {
  cell.assumptions = assumptions;
  cell.limits = limits;
}

process.stdout.write(`${JSON.stringify({
  schemaVersion: 1,
  instrument: 14,
  subject: "vocabulary pack pair",
  axes: [17],
  mode: parameters.smoke ? "smoke" : "measure",
  parameters,
  cells,
  assumptions,
  limits,
}, null, 2)}\n`);
