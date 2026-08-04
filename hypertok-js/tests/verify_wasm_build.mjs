import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST_DIR, "../..");
const MANIFEST = "Cargo.toml";
const TARGET = "wasm32-unknown-unknown";
const TOOLCHAIN =
  process.env.HYPERTOK_RUST_TOOLCHAIN ??
  (process.platform === "win32" ? "stable-x86_64-pc-windows-msvc" : "stable");

const FORBIDDEN_DEPENDENCIES = [
  "arrow-array",
  "arrow-schema",
  "dashmap",
  "flate2",
  "icu",
  "indicatif",
  "memmap2",
  "numpy",
  "parquet",
  "priority-queue",
  "pyo3",
  "rayon",
  "simdutf",
  "sonic-rs",
  "spm_precompiled",
  "ureq",
  "winnow",
  "zstd",
];

const FORBIDDEN_FEATURES = [
  "native-batch",
  "native-hub",
  "native-io",
  "native-json",
  "native-unicode",
  "native-utf8",
  "parallel",
  "portable-simd",
  "python",
  "reference",
  "sentencepiece",
  "training",
];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, ...options.env },
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with ${result.status}\n${result.stdout}${result.stderr}`,
    );
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertForbiddenAbsent(names) {
  const present = FORBIDDEN_DEPENDENCIES.filter((name) => names.has(name));
  assert.deepEqual(present, [], `forbidden dependencies present: ${present.join(", ")}`);
}

function assertFeatures(features) {
  const enabled = new Set(features);
  for (const required of ["portable-json", "source-loaders", "wasm-binding"]) {
    assert(enabled.has(required), `required artifact feature is absent: ${required}`);
  }
  const present = FORBIDDEN_FEATURES.filter((name) => enabled.has(name));
  assert.deepEqual(present, [], `forbidden artifact features present: ${present.join(", ")}`);
}

function readU32(bytes, cursor) {
  let value = 0;
  let shift = 0;
  while (true) {
    assert(cursor.offset < bytes.length, "truncated unsigned LEB128 value");
    const byte = bytes[cursor.offset];
    cursor.offset += 1;
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return value >>> 0;
    shift += 7;
    assert(shift < 35, "u32 LEB128 value is too wide");
  }
}

function readName(bytes, cursor) {
  const length = readU32(bytes, cursor);
  cursor.offset += length;
  assert(cursor.offset <= bytes.length, "truncated WebAssembly name");
}

function readLimits(bytes, cursor) {
  const flags = readU32(bytes, cursor);
  assert.equal(flags & 0x04, 0, "memory64 is outside the unthreaded artifact contract");
  readU32(bytes, cursor);
  if ((flags & 0x01) !== 0) readU32(bytes, cursor);
  return { shared: (flags & 0x02) !== 0 };
}

function readImportedMemories(bytes, start, end) {
  const cursor = { offset: start };
  const memories = [];
  const count = readU32(bytes, cursor);
  for (let index = 0; index < count; index += 1) {
    readName(bytes, cursor);
    readName(bytes, cursor);
    assert(cursor.offset < end, "truncated WebAssembly import");
    const kind = bytes[cursor.offset];
    cursor.offset += 1;
    if (kind === 0) {
      readU32(bytes, cursor);
    } else if (kind === 1) {
      cursor.offset += 1;
      readLimits(bytes, cursor);
    } else if (kind === 2) {
      memories.push(readLimits(bytes, cursor));
    } else if (kind === 3) {
      cursor.offset += 2;
    } else if (kind === 4) {
      readU32(bytes, cursor);
      readU32(bytes, cursor);
    } else {
      assert.fail(`unknown WebAssembly import kind ${kind}`);
    }
  }
  assert.equal(cursor.offset, end, "WebAssembly import section has trailing bytes");
  return memories;
}

function readDefinedMemories(bytes, start, end) {
  const cursor = { offset: start };
  const memories = [];
  const count = readU32(bytes, cursor);
  for (let index = 0; index < count; index += 1) {
    memories.push(readLimits(bytes, cursor));
  }
  assert.equal(cursor.offset, end, "WebAssembly memory section has trailing bytes");
  return memories;
}

function inspectArtifact(bytes, label, expectedExports = []) {
  assert(bytes.length >= 8, `${label} is too short to be WebAssembly`);
  assert.deepEqual(
    Array.from(bytes.subarray(0, 8)),
    [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00],
    `${label} has an invalid WebAssembly header`,
  );
  const module = new WebAssembly.Module(bytes);
  const memories = [];
  const cursor = { offset: 8 };
  while (cursor.offset < bytes.length) {
    const section = bytes[cursor.offset];
    cursor.offset += 1;
    const size = readU32(bytes, cursor);
    const start = cursor.offset;
    const end = start + size;
    assert(end <= bytes.length, `${label} has a truncated section ${section}`);
    if (section === 2) memories.push(...readImportedMemories(bytes, start, end));
    if (section === 5) memories.push(...readDefinedMemories(bytes, start, end));
    cursor.offset = end;
  }
  assert.equal(memories.length, 1, `${label} must declare exactly one linear memory`);
  assert.equal(memories[0].shared, false, `${label} declares shared memory`);
  const exports = WebAssembly.Module.exports(module).map(({ name }) => name);
  for (const expected of expectedExports) {
    assert(exports.includes(expected), `${label} is missing export ${expected}`);
  }
  return {
    bytes: bytes.length,
    sha256: sha256(bytes),
    imports: WebAssembly.Module.imports(module).length,
    exports: exports.length,
  };
}

function assertWrapperSurface(wrapper) {
  assert.ok(Object.hasOwn(wrapper, "WasmTokenizer"));
  assert.equal(typeof wrapper.WasmTokenizer.fromHuggingFace, "function");
  assert.equal(typeof wrapper.WasmTokenizer.fromTiktoken, "function");
  assert.equal(typeof wrapper.WasmTokenizer.prototype.encode, "function");
  assert.equal(typeof wrapper.WasmTokenizer.prototype.vocabSize, "function");
}

function expectRed(label, pattern, action) {
  assert.throws(action, pattern, `${label} mutation remained green`);
  return label;
}

function runNegativeTests() {
  const red = [];
  const clean = new Set(["hypertok", "serde_json", "wasm-bindgen"]);
  assertForbiddenAbsent(clean);
  for (const dependency of FORBIDDEN_DEPENDENCIES) {
    red.push(
      expectRed(`dependency:${dependency}`, /forbidden dependencies present/, () =>
        assertForbiddenAbsent(new Set([...clean, dependency])),
      ),
    );
  }

  const cleanFeatures = ["portable-json", "source-loaders", "wasm-binding"];
  assertFeatures(cleanFeatures);
  for (const feature of FORBIDDEN_FEATURES) {
    red.push(
      expectRed(`feature:${feature}`, /forbidden artifact features present/, () =>
        assertFeatures([...cleanFeatures, feature]),
      ),
    );
  }

  const sharedMemory = Uint8Array.from([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    0x05, 0x04, 0x01, 0x03, 0x01, 0x01,
  ]);
  red.push(
    expectRed("artifact:shared-memory", /declares shared memory/, () =>
      inspectArtifact(sharedMemory, "mutation"),
    ),
  );
  red.push(
    expectRed("artifact:missing-memory", /exactly one linear memory/, () =>
      inspectArtifact(Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0]), "mutation"),
    ),
  );
  red.push(
    expectRed("wrapper:missing-export", /Expected values to be strictly deep-equal/, () =>
      assertWrapperSurface({}),
    ),
  );
  assert.equal(
    red.length,
    FORBIDDEN_DEPENDENCIES.length + FORBIDDEN_FEATURES.length + 3,
  );
  return red;
}

function reachableGraph(metadata) {
  const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
  const packages = new Map(metadata.packages.map((pkg) => [pkg.id, pkg.name]));
  const root = nodes.get(metadata.resolve.root);
  assert(root, "Cargo metadata has no resolved root package");
  const seen = new Set();
  const queue = [root.id];
  while (queue.length > 0) {
    const id = queue.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    const node = nodes.get(id);
    assert(node, `Cargo metadata omits resolved node ${id}`);
    for (const dependency of node.deps) {
      if (dependency.dep_kinds.some(({ kind }) => kind !== "dev")) {
        queue.push(dependency.pkg);
      }
    }
  }
  return {
    features: root.features,
    names: new Set([...seen].map((id) => packages.get(id))),
  };
}

const mutations = runNegativeTests();

run(
  "cargo",
  [
    `+${TOOLCHAIN}`,
    "build",
    "--offline",
    "--release",
    "--manifest-path",
    MANIFEST,
    "--target",
    TARGET,
    "--no-default-features",
    "--features",
    "portable-json,source-loaders,wasm-binding",
  ],
  { env: { RUSTFLAGS: "-Dwarnings" } },
);

const metadataResult = run("cargo", [
  `+${TOOLCHAIN}`,
  "metadata",
  "--offline",
  "--manifest-path",
  MANIFEST,
  "--no-default-features",
  "--features",
  "portable-json,source-loaders,wasm-binding",
  "--format-version",
  "1",
  "--filter-platform",
  TARGET,
]);
const metadata = JSON.parse(metadataResult.stdout);
const graph = reachableGraph(metadata);
assertForbiddenAbsent(graph.names);
assertFeatures(graph.features);

const rawPath = path.join(
  metadata.target_directory,
  TARGET,
  "release",
  "hypertok.wasm",
);
const outputDirectory = path.join(metadata.target_directory, "pkg-test");
const wrapperPath = path.join(outputDirectory, "hypertok_wasm_core.js");
const boundPath = path.join(outputDirectory, "hypertok_wasm_core_bg.wasm");

const bindgenVersion = run("wasm-bindgen", ["--version"]).stdout.trim();
assert.equal(bindgenVersion, "wasm-bindgen 0.2.125");
run("wasm-bindgen", [
  "--target",
  "nodejs",
  "--out-dir",
  outputDirectory,
  "--out-name",
  "hypertok_wasm_core",
  rawPath,
]);

const tokenizerExports = [
  "memory",
  "wasmtokenizer_encode",
  "wasmtokenizer_fromHuggingFace",
  "wasmtokenizer_fromTiktoken",
  "wasmtokenizer_vocabSize",
];
const raw = inspectArtifact(readFileSync(rawPath), "raw artifact", tokenizerExports);
const bound = inspectArtifact(readFileSync(boundPath), "bound artifact", tokenizerExports);
const require = createRequire(import.meta.url);
delete require.cache[require.resolve(wrapperPath)];
assertWrapperSurface(require(wrapperPath));
run("node", ["hypertok-js/tests/wasm_smoke.mjs"]);

console.log(
  JSON.stringify({
    status: "PASS",
    toolchain: TOOLCHAIN,
    target: TARGET,
    bindgen: bindgenVersion,
    dependency_absence: `${FORBIDDEN_DEPENDENCIES.length}/${FORBIDDEN_DEPENDENCIES.length}`,
    feature_absence: `${FORBIDDEN_FEATURES.length}/${FORBIDDEN_FEATURES.length}`,
    unthreaded_memory: "2/2",
    mutation_red: `${mutations.length}/${mutations.length}`,
    mutation_labels: mutations,
    reachable_packages: graph.names.size,
    raw,
    bound,
  }),
);
