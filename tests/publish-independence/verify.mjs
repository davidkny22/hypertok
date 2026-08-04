import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const packageRoot = path.join(root, "hypertok-vocab");
const resultRoot = path.join(root, "results", "phase6", "publish-independence");
const isolatedRoot = path.join(resultRoot, "isolated");
const packRoot = path.join(resultRoot, "packs");
const cacheRoot = path.join(resultRoot, "npm-cache");
const packages = Object.freeze([
  Object.freeze({
    slug: "o200k",
    packageName: "@hypertok/vocab-o200k",
    license: "MIT",
  }),
  Object.freeze({
    slug: "qwen3-6",
    packageName: "@hypertok/vocab-qwen3-6",
    license: "Apache-2.0",
  }),
  Object.freeze({
    slug: "mistral-tekken",
    packageName: "@hypertok/vocab-mistral-tekken",
    license: "Apache-2.0",
  }),
  Object.freeze({
    slug: "deepseek-v4",
    packageName: "@hypertok/vocab-deepseek-v4",
    license: "MIT",
  }),
  Object.freeze({
    slug: "kimi-k3",
    packageName: "@hypertok/vocab-kimi-k3",
    license: "SEE LICENSE IN LICENSE",
  }),
]);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertNoCoreEdges(manifest) {
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies", "scripts"]) {
    assert.equal(manifest[field], undefined, `${manifest.name} must not declare ${field}`);
  }
}

async function verifyPackage(directory, expected) {
  const manifest = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
  const bytes = await readFile(path.join(directory, "vocab.htk"));
  assert.equal(manifest.name, expected.packageName);
  assert.equal(manifest.license, expected.license);
  assertNoCoreEdges(manifest);
  const fileSha256 = sha256(bytes);
  assert.equal(bytes.subarray(0, 8).toString("ascii"), "HTKVOCAB");
  const formatVersion = bytes.readUInt16LE(8);
  const vocabSize = bytes.readUInt32LE(16);
  const omega = bytes.readUInt32LE(20);
  const vocabularyDigest = bytes.subarray(32, 64).toString("hex");
  const moduleUrl = `${pathToFileURL(path.join(directory, "index.mjs")).href}?gate=${Date.now()}-${expected.slug}`;
  const module = await import(moduleUrl);
  assert.equal(module.metadata.formatVersion, formatVersion);
  assert.equal(module.metadata.fileSha256, fileSha256);
  assert.equal(module.metadata.vocabularyDigest, vocabularyDigest);
  assert.equal(module.metadata.vocabSize, vocabSize);
  assert.equal(module.metadata.omega, omega);
  assert.equal(fileURLToPath(module.vocabulary), path.join(directory, "vocab.htk"));
  return { manifest, bytes: bytes.length, fileSha256 };
}

function npmCommand() {
  if (process.platform !== "win32") return { command: "npm", prefix: [] };
  return {
    command: process.execPath,
    prefix: [path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")],
  };
}

function pack(directory) {
  const npm = npmCommand();
  const result = spawnSync(
    npm.command,
    [...npm.prefix, "pack", "--json", "--ignore-scripts", "--pack-destination", packRoot],
    {
      cwd: directory,
      encoding: "utf8",
      env: {
        ...process.env,
        npm_config_cache: cacheRoot,
        npm_config_audit: "false",
        npm_config_fund: "false",
        npm_config_update_notifier: "false",
      },
    },
  );
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
  const rows = JSON.parse(result.stdout);
  assert.equal(rows.length, 1);
  const row = rows[0];
  return Object.freeze({
    filename: row.filename,
    size: row.size,
    unpackedSize: row.unpackedSize,
    shasum: row.shasum,
    integrity: row.integrity,
  });
}

async function expectRed(name, mutate) {
  const expected = packages[0];
  const source = path.join(packageRoot, expected.slug);
  const target = path.join(resultRoot, "mutations", name);
  await rm(target, { recursive: true, force: true });
  await mkdir(path.dirname(target), { recursive: true });
  await cp(source, target, { recursive: true });
  await mutate(target);
  try {
    await verifyPackage(target, expected);
  } catch (error) {
    return Object.freeze({ name, red: true, cause: error.message });
  }
  throw new Error(`mutation ${name} remained green`);
}

await rm(resultRoot, { recursive: true, force: true });
await mkdir(isolatedRoot, { recursive: true });
await mkdir(packRoot, { recursive: true });

const results = [];
for (const expected of packages) {
  const source = path.join(packageRoot, expected.slug);
  const isolated = path.join(isolatedRoot, expected.slug);
  await cp(source, isolated, { recursive: true });
  const verified = await verifyPackage(isolated, expected);
  const packed = pack(isolated);
  results.push(Object.freeze({
    slug: expected.slug,
    packageName: expected.packageName,
    version: verified.manifest.version,
    formatVersion: 1,
    vocabularyBytes: verified.bytes,
    fileSha256: verified.fileSha256,
    ...packed,
  }));
}

const mutations = [];
mutations.push(await expectRed("vocabulary-byte", async (directory) => {
  const file = path.join(directory, "vocab.htk");
  const bytes = await readFile(file);
  bytes[64] ^= 1;
  await writeFile(file, bytes);
}));
mutations.push(await expectRed("core-dependency", async (directory) => {
  const file = path.join(directory, "package.json");
  const manifest = JSON.parse(await readFile(file, "utf8"));
  manifest.dependencies = { hypertok: "*" };
  await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`);
}));
mutations.push(await expectRed("metadata-digest", async (directory) => {
  const file = path.join(directory, "index.mjs");
  const source = await readFile(file, "utf8");
  await writeFile(
    file,
    source.replace(/fileSha256: "[0-9a-f]{64}"/u, `fileSha256: "${"0".repeat(64)}"`),
  );
}));
mutations.push(await expectRed("escaping-url", async (directory) => {
  const file = path.join(directory, "index.mjs");
  const source = await readFile(file, "utf8");
  await writeFile(file, source.replace("./vocab.htk", "../../src/lib.rs"));
}));

const git = spawnSync(
  "git",
  ["-c", `safe.directory=${root.replaceAll("\\", "/")}`, "rev-parse", "HEAD"],
  { cwd: root, encoding: "utf8" },
);
assert.equal(git.status, 0, git.stderr);
const report = Object.freeze({
  schemaVersion: 1,
  gate: "publish-independence",
  commit: git.stdout.trim(),
  packages: results,
  mutations,
  coreFilesPresentInIsolatedState: 0,
  status: "PASS",
});
await writeFile(path.join(resultRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`);

console.log(`publish-independence PASS commit=${report.commit}`);
console.log(`packages=${results.length}/${packages.length}`);
console.log(`isolated packs=${results.length}/${packages.length}`);
console.log(`mutations RED=${mutations.filter((mutation) => mutation.red).length}/${mutations.length}`);
console.log(`core files in isolated state=${report.coreFilesPresentInIsolatedState}`);
