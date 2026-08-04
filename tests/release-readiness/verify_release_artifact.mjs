import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const packageRoot = path.join(root, "hypertok-js");
const resultParent = path.join(root, "results", "phase6", "release-readiness");
mkdirSync(resultParent, { recursive: true });
const gateRoot = mkdtempSync(path.join(resultParent, "run-"));
const packDirectory = path.join(gateRoot, "pack");
const extractDirectory = path.join(gateRoot, "extract");
mkdirSync(packDirectory);
mkdirSync(extractDirectory);

const npmCandidates = [
  process.env.npm_execpath,
  path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
  path.join(process.env.APPDATA ?? tmpdir(), "npm", "node_modules", "npm", "bin", "npm-cli.js"),
].filter(Boolean);
const npmCli = npmCandidates.find((candidate) => existsSync(candidate));
assert.ok(npmCli, `npm CLI was not found in: ${npmCandidates.join(", ")}`);

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      NO_UPDATE_NOTIFIER: "1",
      npm_config_cache: path.join(gateRoot, "npm-cache"),
    },
  });
  if (result.status !== 0) {
    throw new Error(
      [
        `${path.basename(command)} ${args.join(" ")} failed with status ${result.status}`,
        result.stdout,
        result.stderr,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  return result.stdout.trim();
}

function verifyBudget(manifest, tarballBytes, budget) {
  for (const [name, value] of Object.entries(budget)) {
    assert.ok(Number.isSafeInteger(value) && value > 0, `${name} must be a positive integer`);
  }
  assert.equal(manifest.size, tarballBytes, "npm size differs from the emitted tarball");
  assert.ok(
    tarballBytes <= budget.maxTarballBytes,
    `tarball ${tarballBytes} exceeds ${budget.maxTarballBytes} bytes`,
  );
  assert.ok(
    manifest.unpackedSize <= budget.maxUnpackedBytes,
    `unpacked package ${manifest.unpackedSize} exceeds ${budget.maxUnpackedBytes} bytes`,
  );
}

function collectRuntimeExports(value, output = new Set()) {
  if (typeof value === "string") {
    if (/^\.\/.+\.(?:mjs|js)$/.test(value)) {
      output.add(value.slice(2));
    }
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectRuntimeExports(item, output);
    return output;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectRuntimeExports(item, output);
  }
  return output;
}

function visitAst(value, visitor, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (typeof value.type === "string") visitor(value);
  for (const child of Object.values(value)) {
    if (Array.isArray(child)) {
      for (const item of child) visitAst(item, visitor, seen);
    } else {
      visitAst(child, visitor, seen);
    }
  }
}

function staticString(node) {
  if (node?.type === "Literal" && typeof node.value === "string") return node.value;
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis[0].value.cooked;
  }
  return undefined;
}

function isImportMetaUrl(node) {
  return (
    node?.type === "MemberExpression" &&
    !node.computed &&
    node.property?.type === "Identifier" &&
    node.property.name === "url" &&
    node.object?.type === "MetaProperty" &&
    node.object.meta?.name === "import" &&
    node.object.property?.name === "meta"
  );
}

function isTestModule(modulePath) {
  return (
    /(^|\/)(?:test|tests|__tests__)(?:\/|$)/i.test(modulePath) ||
    /(^|\/)[^/]+\.(?:test|spec)\.[^/]+$/i.test(modulePath)
  );
}

function verifyGraph(packageJson, packedPaths, readSource, parse) {
  const roots = [...collectRuntimeExports(packageJson.exports)].sort();
  assert.ok(roots.length > 0, "package exports contain no runtime roots");

  const graphFiles = new Set(roots);
  const visitedModules = new Set();
  const queue = [...roots];
  const edges = new Set();
  let dynamicImports = 0;

  function addEdge(from, specifier, kind) {
    if (kind === "asset" && !specifier.startsWith(".") && !/^(?:[a-z]+:|\/)/i.test(specifier)) {
      specifier = `./${specifier}`;
    }
    if (!specifier.startsWith(".")) return;
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
    assert.ok(!resolved.startsWith("../") && !path.posix.isAbsolute(resolved), `${from} escapes package root`);
    assert.ok(packedPaths.has(resolved), `${from} resolves missing artifact ${resolved}`);
    assert.ok(!isTestModule(resolved), `${from} resolves test module ${resolved}`);
    edges.add(`${kind}:${from}->${resolved}`);
    graphFiles.add(resolved);
    if (/\.(?:mjs|js)$/.test(resolved) && !visitedModules.has(resolved)) queue.push(resolved);
  }

  while (queue.length > 0) {
    const modulePath = queue.shift();
    if (visitedModules.has(modulePath)) continue;
    assert.ok(packedPaths.has(modulePath), `runtime root is not packed: ${modulePath}`);
    assert.ok(!isTestModule(modulePath), `runtime graph contains test module ${modulePath}`);
    visitedModules.add(modulePath);
    const ast = parse(readSource(modulePath), {
      ecmaVersion: "latest",
      sourceType: "module",
      allowHashBang: true,
    });
    visitAst(ast, (node) => {
      if (
        node.type === "ImportDeclaration" ||
        node.type === "ExportAllDeclaration" ||
        node.type === "ExportNamedDeclaration"
      ) {
        const specifier = staticString(node.source);
        if (specifier !== undefined) addEdge(modulePath, specifier, "module");
      } else if (node.type === "ImportExpression") {
        const specifier = staticString(node.source);
        if (specifier === undefined) dynamicImports += 1;
        else addEdge(modulePath, specifier, "dynamic");
      } else if (
        node.type === "NewExpression" &&
        node.callee?.type === "Identifier" &&
        node.callee.name === "URL" &&
        isImportMetaUrl(node.arguments[1])
      ) {
        const specifier = staticString(node.arguments[0]);
        if (specifier !== undefined) addEdge(modulePath, specifier, "asset");
      }
    });
  }

  const shippedModules = [...packedPaths].filter((entry) => /\.(?:mjs|js)$/.test(entry)).sort();
  assert.deepEqual(
    [...visitedModules].sort(),
    shippedModules,
    "shipped JavaScript differs from the graph reachable through package exports",
  );

  return {
    roots: roots.length,
    modules: visitedModules.size,
    assets: [...graphFiles].filter((entry) => !visitedModules.has(entry)).length,
    edges: edges.size,
    dynamicImports,
  };
}

const packOutput = run(process.execPath, [
  npmCli,
  "pack",
  packageRoot,
  "--pack-destination",
  packDirectory,
  "--json",
]);
const [manifest] = JSON.parse(packOutput);
assert.ok(manifest, "npm pack returned no artifact");
const tarball = path.join(packDirectory, manifest.filename);
const tarballBytes = statSync(tarball).size;
const budget = JSON.parse(
  readFileSync(path.join(root, "tests", "release-readiness", "release-budget.json"), "utf8"),
);
verifyBudget(manifest, tarballBytes, budget);

run("tar", ["-xf", tarball, "-C", extractDirectory]);
const extractedPackage = path.join(extractDirectory, "package");
const packageJson = JSON.parse(readFileSync(path.join(extractedPackage, "package.json"), "utf8"));
const packedPaths = new Set(manifest.files.map((entry) => entry.path.replaceAll("\\", "/")));
const require = createRequire(path.join(packageRoot, "package.json"));
const { parse } = require("acorn");
const readSource = (modulePath) => readFileSync(path.join(extractedPackage, modulePath), "utf8");
const graph = verifyGraph(packageJson, packedPaths, readSource, parse);

let mutationsRed = 0;
assert.throws(() =>
  verifyBudget(
    { ...manifest, size: budget.maxTarballBytes + 1 },
    budget.maxTarballBytes + 1,
    budget,
  ),
);
mutationsRed += 1;
const mutatedPaths = new Set([...packedPaths, "tests/leak.mjs"]);
assert.throws(
  () =>
    verifyGraph(
      packageJson,
      mutatedPaths,
      (modulePath) =>
        modulePath === "src/index.mjs"
          ? `${readSource(modulePath)}\nnew URL("../tests/leak.mjs", import.meta.url);\n`
          : readSource(modulePath),
      parse,
    ),
  /resolves test module/,
);
mutationsRed += 1;

console.log(
  JSON.stringify(
    {
      tarballBytes,
      unpackedBytes: manifest.unpackedSize,
      files: manifest.files.length,
      budget,
      graph,
      mutationsRed,
    },
    null,
    2,
  ),
);
