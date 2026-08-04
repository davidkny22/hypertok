import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "../../benches/node_modules/playwright-core/index.mjs";
import { loadExecutionArtifactManifest } from "../../tests/suites/artifact_manifest.mjs";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const resultRoot = path.join(repository, "results", "reserved-policy-core");
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
const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

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

function gitHead() {
  const result = spawnSync(
    "git",
    ["-c", `safe.directory=${repository.replaceAll("\\", "/")}`, "rev-parse", "HEAD"],
    { cwd: repository, encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

const testPage = `<!doctype html>
<meta charset="utf-8">
<script type="module">
  const mutation = new URL(location.href).searchParams.has("mutation");
  globalThis.resultPromise = (async () => {
    const { createTierRuntime } = await import("/runtime.mjs");
    const { createTiktokenShim } = await import("/tiktoken-shim.mjs");
    const { createHuggingFaceShim } = await import("/huggingface-shim.mjs");
    const vocabulary = new Uint8Array(await (await fetch("/vocabulary")).arrayBuffer());
    const runtime = await createTierRuntime({
      tier: "single",
      format: "htk",
      unthreadedModuleUrl: new URL("/single/hypertok_wasm_core.js", location.href).href,
      vocabulary,
    });
    const END_TEXT = "<|endoftext|>";
    const END_PROMPT = "<|endofprompt|>";
    const END_TEXT_ID = 199999;
    const END_PROMPT_ID = 200018;
    const text = "alpha" + END_TEXT + "beta" + END_PROMPT + "gamma";
    let cases = 0;
    let negatives = 0;
    const check = (condition, message) => {
      if (!condition) throw new Error(message);
      cases += 1;
    };
    const equalIds = (left, right) =>
      left.length === right.length && left.every((value, index) => value === right[index]);
    const expectReject = async (label, action, textPart) => {
      try {
        await action();
      } catch (error) {
        if (textPart !== undefined && !String(error).includes(textPart)) {
          throw new Error(label + " named the wrong error: " + error);
        }
        negatives += 1;
        return;
      }
      throw new Error(label + " did not reject");
    };

    const ordinary = await runtime.encode(text);
    const encodedDefaults = await runtime.encodeReserved(text);
    const defaults = mutation
      ? { ...encodedDefaults, reservedFound: Object.freeze([]) }
      : encodedDefaults;
    check(equalIds(defaults.ids, ordinary), "default reserved policy differs from ordinary encode");
    check(
      JSON.stringify(defaults.reservedFound) === JSON.stringify([END_TEXT, END_PROMPT]),
      "default reporting mismatch",
    );

    const selected = await runtime.encodeReserved(text, { match: [END_TEXT] });
    check(selected.ids.includes(END_TEXT_ID), "selected token was not matched");
    check(!selected.ids.includes(END_PROMPT_ID), "unselected token was not literal");
    check(
      JSON.stringify(selected.reservedFound) === JSON.stringify(defaults.reservedFound),
      "selective policy changed reporting",
    );

    const literal = await runtime.encodeReserved(text, { match: [] });
    check(!literal.ids.includes(END_TEXT_ID), "literal policy matched endoftext");
    check(!literal.ids.includes(END_PROMPT_ID), "literal policy matched endofprompt");
    check(!equalIds(literal.ids, defaults.ids), "literal policy did not change ids");
    check(
      JSON.stringify(literal.reservedFound) === JSON.stringify(defaults.reservedFound),
      "literal policy changed reporting",
    );

    const throughEncode = await runtime.encode(text, { reserved: { match: [] } });
    check(equalIds(throughEncode, literal.ids), "encode reserved option differs from detailed ids");
    const throughSync = runtime.encodeSync(text, { reserved: { match: [] } });
    check(equalIds(throughSync, literal.ids), "encodeSync reserved option differs from detailed ids");

    const repeated = await runtime.encodeReserved(
      END_PROMPT + END_TEXT + END_PROMPT + END_TEXT,
      { match: [] },
    );
    check(
      JSON.stringify(repeated.reservedFound) === JSON.stringify([END_PROMPT, END_TEXT]),
      "repeated reporting order or uniqueness mismatch",
    );

    const duplicate = await runtime.encodeReserved(text, { match: [END_TEXT, END_TEXT] });
    check(equalIds(duplicate.ids, selected.ids), "duplicate policy names changed selection");
    check(runtime.telemetry().tier === "single", "reserved policy left resident single");
    check(runtime.telemetry().fallback === false, "resident single reported a fallback");
    check(runtime.telemetry().cause === "reserved-policy", "reserved telemetry cause mismatch");

    const tiktoken = createTiktokenShim(runtime, { name: "o200k_base" });
    await expectReject("tiktoken default refusal", () => tiktoken.encode(text), END_TEXT);
    check(equalIds(tiktoken.encode(text, "all"), defaults.ids), "tiktoken allowed all mismatch");
    await expectReject(
      "tiktoken allowed subtraction",
      () => tiktoken.encode(text, [END_TEXT], "all"),
      END_PROMPT,
    );
    check(equalIds(tiktoken.encode(text, [], []), literal.ids), "tiktoken literal mismatch");
    check(
      equalIds(tiktoken.encode(text, ["<|unknown|>"], ["<|unknown|>"]), literal.ids),
      "tiktoken unknown selector mismatch",
    );
    check(equalIds(tiktoken.encode_ordinary(text), literal.ids), "tiktoken ordinary mismatch");
    const tiktokenDetailed = tiktoken.encodeReserved(text, { match: "all" });
    check(equalIds(tiktokenDetailed.ids, defaults.ids), "tiktoken detailed ids mismatch");
    check(
      JSON.stringify(tiktokenDetailed.reservedFound) === JSON.stringify(defaults.reservedFound),
      "tiktoken detailed reporting mismatch",
    );
    const tiktokenLiteral = tiktoken.encodeReserved(text, { match: [] });
    check(
      JSON.stringify(tiktokenLiteral.reservedFound) === JSON.stringify(defaults.reservedFound),
      "tiktoken literal reporting mismatch",
    );
    await expectReject(
      "tiktoken detailed refusal",
      () => tiktoken.encodeReserved(text, { refuse: [END_TEXT] }),
      END_TEXT,
    );

    const huggingFace = createHuggingFaceShim(runtime, {
      tokenString: (id) => (Number.isInteger(id) && id >= 0 && id <= END_PROMPT_ID
        ? String(id)
        : undefined),
      postProcess: (first, second) => ({
        ids: second === null ? first : [...first, ...second],
        token_type_ids: second === null
          ? first.map(() => 0)
          : [...first.map(() => 0), ...second.map(() => 1)],
      }),
      specialTokens: [END_TEXT, END_PROMPT],
      unknownTokenId: 0,
      cleanUpTokenizationSpaces: false,
    });
    const hfDefault = huggingFace.encode(text, { add_special_tokens: false });
    check(equalIds(hfDefault.ids, defaults.ids), "Hugging Face default match mismatch");
    check(
      hfDefault.attention_mask.every((value) => value === 1) &&
        hfDefault.attention_mask.length === hfDefault.ids.length,
      "Hugging Face attention mask mismatch",
    );
    const hfTypes = huggingFace.encode(text, {
      add_special_tokens: false,
      return_token_type_ids: true,
    });
    check(
      hfTypes.token_type_ids.every((value) => value === 0) &&
        hfTypes.token_type_ids.length === hfTypes.ids.length,
      "Hugging Face token type ids mismatch",
    );
    const hfLiteral = huggingFace.encodeReserved(
      text,
      { match: [] },
      { add_special_tokens: false },
    );
    check(equalIds(hfLiteral.ids, literal.ids), "Hugging Face literal mismatch");
    check(
      JSON.stringify(hfLiteral.reservedFound) === JSON.stringify(defaults.reservedFound),
      "Hugging Face reporting mismatch",
    );
    await expectReject(
      "Hugging Face detailed refusal",
      () => huggingFace.encodeReserved(text, { refuse: [END_TEXT] }, { add_special_tokens: false }),
      END_TEXT,
    );

    await expectReject(
      "specific refusal",
      () => runtime.encodeReserved(text, { refuse: [END_PROMPT] }),
      END_PROMPT,
    );
    await expectReject(
      "refusal wins",
      () => runtime.encodeReserved(text, { match: [END_TEXT], refuse: [END_TEXT] }),
      END_TEXT,
    );
    await expectReject(
      "refuse all",
      () => runtime.encodeReserved(text, { refuse: "all" }),
      END_TEXT,
    );
    await expectReject(
      "unknown match",
      () => runtime.encodeReserved(text, { match: ["<|unknown|>"] }),
      "unknown",
    );
    await expectReject(
      "unknown refuse",
      () => runtime.encodeReserved(text, { refuse: ["<|unknown|>"] }),
      "unknown",
    );
    await expectReject("null policy", () => runtime.encodeReserved(text, null));
    await expectReject("invalid match selector", () => runtime.encodeReserved(text, { match: "none" }));
    await expectReject("invalid match name", () => runtime.encodeReserved(text, { match: [1] }));
    await expectReject("invalid refuse selector", () => runtime.encodeReserved(text, { refuse: false }));

    await runtime.close();
    await expectReject("closed runtime", () => runtime.encodeReserved(text));
    return { cases, negatives, found: defaults.reservedFound, tier: "single" };
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
  if (url.pathname === "/runtime.mjs") {
    filePath = runtimePath;
  } else if (url.pathname === "/optimization-config.mjs") {
    filePath = optimizationPath;
  } else if (url.pathname === "/tiktoken-shim.mjs") {
    filePath = tiktokenShimPath;
  } else if (url.pathname === "/huggingface-shim.mjs") {
    filePath = huggingFaceShimPath;
  } else if (/^\/[a-z0-9-]+\.mjs$/.test(url.pathname)) {
    filePath = under(sourceRoot, url.pathname.slice(1));
  } else if (url.pathname === "/vocabulary") {
    filePath = vocabulary;
  } else if (url.pathname.startsWith("/single/")) {
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
let result;
let mutationRed = false;
try {
  const page = await browser.newPage();
  page.on("request", (request) => requests.push(request.url()));
  await page.goto(`http://127.0.0.1:${address.port}/`);
  result = await page.evaluate(() => globalThis.resultPromise);
  await page.close();

  const mutation = await browser.newPage();
  mutation.on("request", (request) => requests.push(request.url()));
  await mutation.goto(`http://127.0.0.1:${address.port}/?mutation`);
  try {
    await mutation.evaluate(() => globalThis.resultPromise);
  } catch (error) {
    mutationRed = String(error).includes("reporting mismatch");
  }
  await mutation.close();
} finally {
  await browser.close();
  await new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

assert.equal(result.cases, 28);
assert.equal(result.negatives, 14);
assert.deepEqual(result.found, ["<|endoftext|>", "<|endofprompt|>"]);
assert.equal(result.tier, "single");
assert.equal(mutationRed, true, "reserved reporting mutation did not go RED");
assert.ok(
  requests.every((url) => new URL(url).hostname === "127.0.0.1"),
  "browser made a non-local request",
);

const report = {
  schemaVersion: 1,
  commit: gitHead(),
  browser: result,
  mutationRed,
  requests: { local: requests.length, external: 0 },
};
fs.mkdirSync(resultRoot, { recursive: true });
fs.writeFileSync(path.join(resultRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ pass: true, ...report })}\n`);
