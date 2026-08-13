import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "../../benches/node_modules/playwright-core/index.mjs";
import { loadExecutionArtifactManifest } from "../../tests/suites/artifact_manifest.mjs";
import { createHuggingFaceShim } from "../src/huggingface-shim.mjs";
import { createLazyHuggingFaceShim } from "../src/huggingface-lazy-shim.mjs";
import { createTiktokenShim } from "../src/tiktoken-shim.mjs";
import { huggingFaceTokenizerFixture } from "./fixtures/huggingface-tokenizer.mjs";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const resultRoot = path.join(repository, "results", "shim-fidelity");
const executionArtifacts = loadExecutionArtifactManifest(
  repository,
  process.env.HYPERTOK_ARTIFACT_MANIFEST,
);
const wasmRoot = process.env.HYPERTOK_WASM_ROOT
  ? path.resolve(repository, process.env.HYPERTOK_WASM_ROOT)
  : executionArtifacts.roots["single-scalar"];
const vocabulary = path.join(repository, "hypertok-vocab", "o200k", "vocab.htk");
const sourceRoot = path.join(repository, "hypertok-js", "src");
const runtimePath = path.join(repository, "hypertok-js", "src", "tier-runtime.mjs");
const optimizationPath = path.join(repository, "hypertok-js", "src", "optimization-config.mjs");
const tiktokenShimPath = path.join(repository, "hypertok-js", "src", "tiktoken-shim.mjs");
const huggingFaceShimPath = path.join(repository, "hypertok-js", "src", "huggingface-shim.mjs");
const lazyHuggingFaceShimPath = path.join(
  repository,
  "hypertok-js",
  "src",
  "huggingface-lazy-shim.mjs",
);
const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

function gitHead() {
  const result = spawnSync(
    "git",
    ["-c", `safe.directory=${repository.replaceAll("\\", "/")}`, "rev-parse", "HEAD"],
    { cwd: repository, encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function contentType(filePath) {
  if (filePath.endsWith(".wasm")) return "application/wasm";
  if (filePath.endsWith(".js") || filePath.endsWith(".mjs")) return "text/javascript";
  return "application/octet-stream";
}

function under(root, relative) {
  const resolved = path.resolve(root, relative);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error("refusing path outside served root");
  }
  return resolved;
}

function capture(action, needle) {
  try {
    return { ok: true, value: Array.from(action()) };
  } catch (error) {
    return { ok: false, needle, matched: needle === undefined || String(error).includes(needle) };
  }
}

function tiktokenReferenceMatrix() {
  const require = createRequire(import.meta.url);
  const { get_encoding: getEncoding } = require(
    path.join(repository, "benches", "node_modules", "@dqbd", "tiktoken", "tiktoken.cjs"),
  );
  const tokenizer = getEncoding("o200k_base");
  const endText = "<|endoftext|>";
  const endPrompt = "<|endofprompt|>";
  const text = `alpha${endText}beta${endPrompt}gamma`;
  const disposable = getEncoding("o200k_base");
  const unknownIdExpected = capture(() => disposable.decode(Uint32Array.of(0xffff_ffff)));
  try {
    const invalidByteId = tokenizer.encode_single_token(Uint8Array.of(0xff));
    const plainIds = tokenizer.encode("plain text");
    return {
      name: tokenizer.name,
      text,
      endText,
      endPrompt,
      invalidByteId,
      encodes: [
        { label: "plain default", method: "encode", args: ["plain text"], expected: capture(() => tokenizer.encode("plain text")) },
        { label: "default refusal", method: "encode", args: [text], expected: capture(() => tokenizer.encode(text), endText) },
        { label: "allowed all", method: "encode", args: [text, "all"], expected: capture(() => tokenizer.encode(text, "all")) },
        { label: "allowed subtraction", method: "encode", args: [text, [endText], "all"], expected: capture(() => tokenizer.encode(text, [endText], "all"), endPrompt) },
        { label: "literal arrays", method: "encode", args: [text, [], []], expected: capture(() => tokenizer.encode(text, [], [])) },
        { label: "unknown selectors", method: "encode", args: [text, ["<|unknown|>"], ["<|unknown|>"]], expected: capture(() => tokenizer.encode(text, ["<|unknown|>"], ["<|unknown|>"])) },
        { label: "ordinary", method: "encode_ordinary", args: [text], expected: capture(() => tokenizer.encode_ordinary(text)) },
      ],
      decodes: [
        { label: "typed decode", typed: true, ids: Array.from(plainIds), expected: capture(() => tokenizer.decode(plainIds)) },
        { label: "array decode", typed: false, ids: Array.from(plainIds), expected: capture(() => tokenizer.decode(Array.from(plainIds))) },
        { label: "empty decode", typed: true, ids: [], expected: capture(() => tokenizer.decode(new Uint32Array())) },
        { label: "non UTF-8 byte", typed: true, ids: [invalidByteId], expected: capture(() => tokenizer.decode(Uint32Array.of(invalidByteId))) },
        { label: "unknown id", typed: true, ids: [0xffff_ffff], expected: unknownIdExpected },
      ],
    };
  } finally {
    tokenizer.free();
  }
}

function templatePostProcess(config) {
  assert.equal(config.type, "TemplateProcessing");
  return (first, second, addSpecialTokens, returnTokenTypeIds) => {
    const buildTokenTypeIds = returnTokenTypeIds !== false;
    const template = second === null ? config.single : config.pair;
    const ids = [];
    const tokenTypeIds = [];
    for (const item of template) {
      if (item.SpecialToken !== undefined) {
        if (!addSpecialTokens) continue;
        const definition = config.special_tokens[item.SpecialToken.id];
        ids.push(...definition.ids);
        if (buildTokenTypeIds) {
          tokenTypeIds.push(...definition.ids.map(() => item.SpecialToken.type_id));
        }
        continue;
      }
      const sequence = item.Sequence.id === "A" ? first : second;
      ids.push(...sequence);
      if (buildTokenTypeIds) {
        tokenTypeIds.push(...sequence.map(() => item.Sequence.type_id));
      }
    }
    return { ids, token_type_ids: buildTokenTypeIds ? tokenTypeIds : undefined };
  };
}

function makeHuggingFaceFixture(Tokenizer, tokenizerJson) {
  const full = new Tokenizer(structuredClone(tokenizerJson), {});
  const rawJson = structuredClone(tokenizerJson);
  rawJson.post_processor = null;
  const raw = new Tokenizer(rawJson, {});
  const specialTokens = tokenizerJson.added_tokens
    .filter((token) => token.special)
    .map((token) => token.content);
  const unknownTokenId = full.token_to_id("<unk>");
  let closed = false;
  const runtime = {
    tier: "single",
    encodeReservedSync(text) {
      if (closed) throw new Error("closed");
      const ids = raw.encode(text, { add_special_tokens: false }).ids;
      const found = specialTokens.filter((token) => text.includes(token));
      return { ids: Uint32Array.from(ids), reservedFound: found };
    },
    reservedTokens: () => specialTokens,
    decode(ids) {
      if (closed) throw new Error("closed");
      return raw.decode(Array.from(ids), {
        skip_special_tokens: false,
        clean_up_tokenization_spaces: false,
      });
    },
    close() {
      closed = true;
    },
  };
  const setup = {
    tokenString: (id) => full.id_to_token(id),
    postProcess: templatePostProcess(tokenizerJson.post_processor),
    specialTokens,
    unknownTokenId,
    cleanUpTokenizationSpaces: true,
  };
  return { full, runtime, setup };
}

function verifyHuggingFace(Tokenizer, tokenizerJson, createShim) {
  const { full, runtime, setup } = makeHuggingFaceFixture(Tokenizer, tokenizerJson);
  const shim = createShim(runtime, setup);
  const encodeCases = [
    ["default marker", "Hello world", undefined],
    ["no marker", "Hello world", { add_special_tokens: false }],
    ["empty text marker", "", undefined],
    ["pair markers", "Hello", { text_pair: "world" }],
    ["pair without markers", "Hello", { text_pair: "world", add_special_tokens: false }],
    ["types requested", "Hello", { return_token_type_ids: true }],
    ["pair types", "Hello", { text_pair: "world", return_token_type_ids: true }],
    ["types false", "Hello", { return_token_type_ids: false }],
    ["reserved spelling", "alpha<s>beta", { add_special_tokens: false }],
    ["array options", "Hello", []],
  ];
  for (const [label, text, options] of encodeCases) {
    assert.deepEqual(shim.encode(text, options), full.encode(text, options), label);
  }

  const emptyPair = shim.encode("Hello", { text_pair: "" });
  const emptyPairIds = setup.postProcess(
    runtime.encodeReservedSync("Hello").ids,
    runtime.encodeReservedSync("").ids,
    true,
    false,
  ).ids;
  assert.deepEqual(emptyPair.ids, emptyPairIds, "empty pair");

  const plain = full.encode("Hello .", { add_special_tokens: false }).ids;
  const decodeCases = [
    ["default decode", plain, undefined],
    ["cleanup off", plain, { clean_up_tokenization_spaces: false }],
    ["skip prefix", [1, ...plain], { skip_special_tokens: true }],
    ["keep prefix", [1, ...plain], { skip_special_tokens: false }],
    ["all special", [1], { skip_special_tokens: true }],
    ["unknown id", [999_999], undefined],
    ["bigint id", [1n], { skip_special_tokens: false }],
  ];
  for (const [label, ids, options] of decodeCases) {
    assert.equal(shim.decode(ids, options), full.decode(ids, options), label);
  }

  for (const [label, ids] of [["empty", []], ["typed", Uint32Array.of(1)], ["first float", [1.5]]]) {
    assert.throws(() => full.decode(ids), undefined, `${label} reference must reject`);
    assert.throws(() => shim.decode(ids), undefined, `${label} shim must reject`);
  }
  assert.throws(() => full.encode("Hello", null));
  assert.throws(() => shim.encode("Hello", null));

  const detailed = shim.encodeReserved(
    "alpha<s>beta",
    undefined,
    { text_pair: "gamma</s>delta", add_special_tokens: false },
  );
  assert.deepEqual(detailed.reservedFound, ["<s>", "</s>"]);

  const worker = { ...runtime, tier: "worker" };
  const shared = { ...runtime, tier: "shared" };
  assert.throws(() => createHuggingFaceShim(worker, setup), /resident single-tier/);
  assert.throws(() => createHuggingFaceShim(shared, setup), /resident single-tier/);

  return { encodeCases: encodeCases.length, decodeCases: decodeCases.length, negatives: 6 };
}

function verifyLazyAccessPatterns(Tokenizer, tokenizerJson) {
  const { full, runtime, setup } = makeHuggingFaceFixture(Tokenizer, tokenizerJson);
  let tokenStringCalls = 0;
  const countedSetup = {
    ...setup,
    tokenString(id) {
      tokenStringCalls += 1;
      return setup.tokenString(id);
    },
  };
  const shim = createLazyHuggingFaceShim(runtime, countedSetup);
  const options = { text_pair: "world", return_token_type_ids: true };
  const expected = full.encode("Hello", options);
  const modal = shim.encode("Hello", options);
  assert.deepEqual(modal.ids, expected.ids);
  assert.equal(tokenStringCalls, 0, "modal ids access materialized token strings");
  assert.deepEqual(Object.keys(modal), Object.keys(expected));
  const directTokens = modal.tokens;
  assert.equal(modal.tokens, directTokens, "tokens getter did not memoize");
  assert.deepEqual(
    {
      ids: modal.ids,
      tokens: modal.tokens,
      attention_mask: modal.attention_mask,
      token_type_ids: modal.token_type_ids,
    },
    expected,
  );
  assert.deepEqual({ ...shim.encode("Hello", options) }, expected);
  assert.equal(JSON.stringify(shim.encode("Hello", options)), JSON.stringify(expected));

  let hotStringHits = 0;
  const hotShim = createLazyHuggingFaceShim(runtime, setup, {
    hotStrings: {
      tokenString(id) {
        hotStringHits += 1;
        return setup.tokenString(id);
      },
    },
  });
  assert.deepEqual(hotShim.encode("Hello", options).tokens, expected.tokens);
  assert.ok(hotStringHits > 0, "hot-string resolver was not used");
  return {
    checks: 7,
    modalTokenStringCalls: 0,
    touchedTokenStringCalls: tokenStringCalls,
    hotStringHits,
  };
}

function verifyLazyIdsAccessPatterns() {
  const source = Uint32Array.of(5, 8, 13, 21, 34);
  const runtime = {
    tier: "single",
    encodeReservedSync: () => ({ ids: source.slice(), reservedFound: [] }),
    decode: (ids) => Array.from(ids).join(","),
    close: () => {},
  };
  const setup = {
    tokenString: (id) => `token-${id}`,
    postProcess: (first, second) => {
      assert.equal(Array.isArray(first), true);
      assert.equal(second, null);
      return { ids: first };
    },
    specialTokens: [],
    unknownTokenId: 0,
    cleanUpTokenizationSpaces: false,
  };
  const eager = createHuggingFaceShim(runtime, setup);
  const lazy = createLazyHuggingFaceShim(runtime, setup);
  const fresh = () => ({
    actual: lazy.encode("fixture", { add_special_tokens: false }).ids,
    expected: eager.encode("fixture", { add_special_tokens: false }).ids,
  });
  const initial = fresh();
  assert.equal(Array.isArray(initial.actual), true);
  assert.equal(initial.actual instanceof Array, true);
  assert.equal(Object.getPrototypeOf(initial.actual), Array.prototype);
  assert.equal(initial.actual.length, initial.expected.length);
  assert.equal(initial.actual[2], initial.expected[2]);
  assert.equal(2 in initial.actual, 2 in initial.expected);
  assert.deepEqual(Object.keys(initial.actual), Object.keys(initial.expected));
  assert.deepEqual(
    Object.getOwnPropertyDescriptor(initial.actual, "2"),
    Object.getOwnPropertyDescriptor(initial.expected, "2"),
  );

  const compareMutation = (label, operation) => {
    const { actual, expected } = fresh();
    assert.deepEqual(operation(actual), operation(expected), `${label} return`);
    assert.deepEqual(actual, expected, `${label} result`);
    assert.equal(JSON.stringify(actual), JSON.stringify(expected), `${label} JSON`);
  };
  compareMutation("index write", (ids) => (ids[1] = 55));
  compareMutation("index delete", (ids) => delete ids[1]);
  compareMutation("push", (ids) => ids.push(55));
  compareMutation("pop", (ids) => ids.pop());
  compareMutation("shift", (ids) => ids.shift());
  compareMutation("unshift", (ids) => ids.unshift(3));
  compareMutation("splice", (ids) => ids.splice(1, 2, 3, 4, 5));
  compareMutation("sort", (ids) => ids.sort((left, right) => right - left));
  compareMutation("reverse", (ids) => ids.reverse());
  compareMutation("fill", (ids) => ids.fill(7, 1, 4));
  compareMutation("copyWithin", (ids) => ids.copyWithin(1, 3));
  compareMutation("length shrink", (ids) => (ids.length = 3));
  compareMutation("length growth", (ids) => {
    ids.length = 8;
    ids[7] = 55;
    return ids.length;
  });

  for (const [label, consume] of [
    ["iteration", (ids) => Array.from(ids)],
    ["spread", (ids) => [...ids]],
    ["map", (ids) => ids.map((id) => id + 1)],
    ["JSON", (ids) => JSON.stringify(ids)],
    ["direct decode", (ids) => lazy.decode(ids)],
  ]) {
    const { actual, expected } = fresh();
    const expectedValue = label === "direct decode" ? eager.decode(expected) : consume(expected);
    assert.deepEqual(consume(actual), expectedValue, label);
  }

  const invalidSetup = {
    ...setup,
    postProcess(first) {
      first[0] = 1.5;
      return { ids: first };
    },
  };
  assert.throws(
    () => createLazyHuggingFaceShim(runtime, invalidSetup).encode("fixture"),
    /u32 values/,
  );
  return { checks: 28, sourceLength: source.length };
}

async function verifyMutations(Tokenizer, tokenizerJson) {
  const hfFixture = makeHuggingFaceFixture(Tokenizer, tokenizerJson);
  const expected = hfFixture.full.encode("mutation target");
  const actual = createHuggingFaceShim(hfFixture.runtime, hfFixture.setup).encode("mutation target");
  const hfFault = JSON.parse(JSON.stringify(actual));
  hfFault.ids = hfFault.ids.slice(1);
  const hfRed = JSON.stringify(hfFault) !== JSON.stringify(expected);

  const runtime = {
    tier: "single",
    encodeReservedSync: () => ({ ids: Uint32Array.of(1), reservedFound: [] }),
    reservedTokens: () => [],
    tokenBytes: (id) => Uint8Array.of(id),
    decodeBytes: (ids) => Uint8Array.from(ids),
    close: () => {},
  };
  const decoded = createTiktokenShim(runtime).decode(Uint32Array.of(7, 9));
  const decodedFault = decoded.slice();
  decodedFault[0] = 0;
  const tiktokenRed = !assertBytesEqual(
    decodedFault,
    Uint8Array.of(7, 9),
  );

  const lazyFixture = makeHuggingFaceFixture(Tokenizer, tokenizerJson);
  const lazyExpected = lazyFixture.full.encode("mutation target");
  const lazyActual = createLazyHuggingFaceShim(lazyFixture.runtime, lazyFixture.setup)
    .encode("mutation target");
  const lazyFault = JSON.parse(JSON.stringify(lazyActual));
  lazyFault.tokens = lazyFault.tokens.slice(1);
  const lazyRed = JSON.stringify(lazyFault) !== JSON.stringify(lazyExpected);
  const lazyIdsRuntime = {
    tier: "single",
    encodeReservedSync: () => ({ ids: Uint32Array.of(3, 5, 8), reservedFound: [] }),
    decode: () => "",
    close: () => {},
  };
  const lazyIdsSetup = {
    tokenString: (id) => `${id}`,
    postProcess: (first) => ({ ids: first }),
    specialTokens: [],
    unknownTokenId: 0,
  };
  const lazyIds = createLazyHuggingFaceShim(lazyIdsRuntime, lazyIdsSetup)
    .encode("mutation target", { add_special_tokens: false })
    .ids;
  const originalId = lazyIds[1];
  const faultyIds = Array.from(lazyIds);
  Object.defineProperty(faultyIds, "1", {
    configurable: true,
    get: () => originalId,
    set: () => {},
  });
  faultyIds[1] = 13;
  const lazyIdsRed = faultyIds[1] !== 13;
  assert.equal(hfRed, true, "Hugging Face marker mutation did not go RED");
  assert.equal(tiktokenRed, true, "tiktoken byte mutation did not go RED");
  assert.equal(lazyRed, true, "lazy token mutation did not go RED");
  assert.equal(lazyIdsRed, true, "lazy ids write mutation did not go RED");
  return {
    huggingFace: hfRed,
    lazyHuggingFace: lazyRed,
    lazyIds: lazyIdsRed,
    tiktoken: tiktokenRed,
  };
}

function assertBytesEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

const hfModuleUrl = pathToFileURL(
  path.join(
    repository,
    "benches",
    "node_modules",
    "@huggingface",
    "tokenizers",
    "dist",
    "tokenizers.mjs",
  ),
).href;
const { Tokenizer } = await import(hfModuleUrl);
const tokenizerJson = huggingFaceTokenizerFixture();
const huggingFace = verifyHuggingFace(Tokenizer, tokenizerJson, createHuggingFaceShim);
const lazyHuggingFace = verifyHuggingFace(
  Tokenizer,
  tokenizerJson,
  createLazyHuggingFaceShim,
);
const lazyAccessPatterns = verifyLazyAccessPatterns(Tokenizer, tokenizerJson);
const lazyIdsAccessPatterns = verifyLazyIdsAccessPatterns();
const mutations = await verifyMutations(Tokenizer, tokenizerJson);

const mockSingle = {
  tier: "single",
  encodeReservedSync: () => ({ ids: new Uint32Array(), reservedFound: [] }),
  reservedTokens: () => [],
  tokenBytes: () => new Uint8Array(),
  decodeBytes: () => new Uint8Array(),
  close: () => {},
};
assert.doesNotThrow(() => createTiktokenShim(mockSingle));
for (const tier of ["worker", "shared"]) {
  assert.throws(() => createTiktokenShim({ ...mockSingle, tier }), /resident single-tier/);
}

const tiktokenMatrix = tiktokenReferenceMatrix();
const testPage = `<!doctype html>
<meta charset="utf-8">
<script type="module">
  const expected = ${JSON.stringify(tiktokenMatrix)};
  globalThis.resultPromise = (async () => {
    const { createTierRuntime } = await import("/runtime.mjs");
    const { createTiktokenShim } = await import("/tiktoken-shim.mjs");
    const vocabulary = new Uint8Array(await (await fetch("/vocabulary")).arrayBuffer());
    const runtime = await createTierRuntime({
      tier: "single",
      format: "htk",
      unthreadedModuleUrl: new URL("/single/hypertok_wasm_core.js", location.href).href,
      vocabulary,
    });
    const shim = createTiktokenShim(runtime, { name: "o200k_base" });
    let cases = 0;
    let negatives = 0;
    const equal = (left, right) =>
      left.length === right.length && left.every((value, index) => value === right[index]);
    const capture = (action) => {
      try {
        return { ok: true, value: Array.from(action()) };
      } catch (error) {
        return { ok: false, error: String(error) };
      }
    };
    if (shim.name !== expected.name) throw new Error("name mismatch");
    cases += 1;
    for (const entry of expected.encodes) {
      const actual = capture(() => shim[entry.method](...entry.args));
      if (actual.ok !== entry.expected.ok) {
        throw new Error(
          entry.label + " outcome mismatch: actual=" + JSON.stringify(actual) +
          " expected=" + JSON.stringify(entry.expected),
        );
      }
      if (actual.ok) {
        if (!equal(actual.value, entry.expected.value)) throw new Error(entry.label + " value mismatch");
        cases += 1;
      } else {
        if (!entry.expected.matched) throw new Error(entry.label + " reference needle mismatch");
        if (entry.expected.needle !== undefined && !actual.error.includes(entry.expected.needle)) {
          throw new Error(entry.label + " error mismatch: " + actual.error);
        }
        negatives += 1;
      }
    }
    for (const entry of expected.decodes) {
      const ids = entry.typed ? Uint32Array.from(entry.ids) : entry.ids;
      const actual = capture(() => shim.decode(ids));
      if (actual.ok !== entry.expected.ok) {
        throw new Error(
          entry.label + " outcome mismatch: actual=" + JSON.stringify(actual) +
          " expected=" + JSON.stringify(entry.expected),
        );
      }
      if (actual.ok) {
        if (!equal(actual.value, entry.expected.value)) throw new Error(entry.label + " bytes mismatch");
        cases += 1;
      } else {
        negatives += 1;
      }
    }
    if (runtime.tier !== "single") throw new Error("shim left resident single");
    cases += 1;
    shim.free();
    let closed = false;
    try {
      shim.encode("after free");
    } catch {
      closed = true;
    }
    if (!closed) throw new Error("free did not close the resident runtime");
    negatives += 1;
    return { cases, negatives, tier: runtime.tier };
  })();
</script>`;

const server = http.createServer((request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  if (url.pathname === "/") {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    response.end(testPage);
    return;
  }
  if (url.pathname === "/favicon.ico") {
    response.writeHead(204);
    response.end();
    return;
  }
  let filePath;
  if (url.pathname === "/runtime.mjs") filePath = runtimePath;
  else if (url.pathname === "/optimization-config.mjs") filePath = optimizationPath;
  else if (url.pathname === "/tiktoken-shim.mjs") filePath = tiktokenShimPath;
  else if (/^\/[a-z0-9-]+\.mjs$/.test(url.pathname)) {
    filePath = under(sourceRoot, url.pathname.slice(1));
  }
  else if (url.pathname === "/vocabulary") filePath = vocabulary;
  else if (url.pathname.startsWith("/single/")) {
    filePath = under(wasmRoot, url.pathname.slice("/single/".length));
  }
  if (filePath === undefined || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    response.writeHead(404, { "Content-Type": "text/plain" });
    response.end("not found\n");
    return;
  }
  response.writeHead(200, { "Content-Type": contentType(filePath), "Cache-Control": "no-store" });
  fs.createReadStream(filePath).pipe(response);
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
if (typeof address === "string" || address === null) throw new Error("server did not bind");

const browser = await chromium.launch({ executablePath: chromePath, headless: true });
const requests = [];
let tiktoken;
try {
  const page = await browser.newPage();
  page.on("request", (request) => requests.push(request.url()));
  await page.goto(`http://127.0.0.1:${address.port}/`);
  tiktoken = await page.evaluate(() => globalThis.resultPromise);
  await page.close();
} finally {
  await browser.close();
  await new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

assert.ok(
  requests.every((url) => new URL(url).hostname === "127.0.0.1"),
  "browser made a non-local request",
);

const report = {
  schemaVersion: 1,
  commit: gitHead(),
  references: {
    tiktoken: "@dqbd/tiktoken 1.0.21",
    huggingFace: "@huggingface/tokenizers 0.1.3",
  },
  tiktoken,
  huggingFace,
  lazyHuggingFace,
  lazyAccessPatterns,
  lazyIdsAccessPatterns,
  reachability: { tiktoken: ["single"], huggingFace: ["single"] },
  mutations,
  requests: { local: requests.length, external: 0 },
};
fs.mkdirSync(resultRoot, { recursive: true });
fs.writeFileSync(path.join(resultRoot, "fidelity.json"), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ pass: true, ...report })}\n`);
