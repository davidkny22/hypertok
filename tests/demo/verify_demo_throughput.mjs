import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const output = path.join(root, "results", "demo");
const packageRoot = path.join(root, "hypertok-js");
const require = createRequire(path.join(packageRoot, "package.json"));
const { chromium } = require("playwright-core");

const mimeTypes = Object.freeze({
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".htk": "application/octet-stream",
});

const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    if (relative === "__throughput__.html") {
      const bytes = Buffer.from("<!doctype html><title>demo throughput gate</title>");
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": bytes.length,
        "Cache-Control": "no-store",
      });
      response.end(bytes);
      return;
    }
    const filePath = path.resolve(output, relative);
    const outputPrefix = `${path.resolve(output)}${path.sep}`;
    if (!filePath.startsWith(outputPrefix)) throw new Error("request escaped demo output");
    const bytes = await readFile(filePath);
    response.writeHead(200, {
      "Content-Type": mimeTypes[path.extname(filePath)] ?? "application/octet-stream",
      "Content-Length": bytes.length,
      "Cache-Control": "no-store",
    });
    response.end(bytes);
  } catch (error) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end(error instanceof Error ? error.message : String(error));
  }
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.ok(address && typeof address === "object");
const origin = `http://127.0.0.1:${address.port}`;
const chromeCandidates = [
  process.env.CHROME_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
].filter(Boolean);
const executablePath = chromeCandidates.find((candidate) => existsSync(candidate));

let browser;
try {
  browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : { channel: "chrome" }),
  });
  const page = await browser.newPage();
  const requestUrls = [];
  page.on("request", (request) => requestUrls.push(request.url()));
  await page.goto(`${origin}/__throughput__.html`, { waitUntil: "domcontentloaded", timeout: 15_000 });

  const report = await page.evaluate(async () => {
    const WINDOW_MS = 10;
    const ROUNDS = 4;
    const ADOPTED_DRIFT = 0.02169;
    const encoder = new TextEncoder();
    const median = (values) => {
      const sorted = values.slice().sort((left, right) => left - right);
      return sorted[Math.floor(sorted.length / 2)];
    };
    const timeWindow = (run) => {
      let iterations = 1;
      for (;;) {
        const started = performance.now();
        for (let index = 0; index < iterations; index += 1) run();
        const elapsed = performance.now() - started;
        if (elapsed >= WINDOW_MS) return elapsed / iterations;
        iterations = Math.max(iterations * 2, Math.ceil((iterations * WINDOW_MS * 1.2) / Math.max(elapsed, 0.1)));
      }
    };
    const stats = (windows) => {
      const usable = windows.slice(1);
      const timeMs = median(usable);
      const minimum = Math.min(...usable);
      const maximum = Math.max(...usable);
      return { timeMs, noise: (maximum - minimum) / timeMs };
    };

    const [{ fromBytes }, rawModule, vocabularyResponse] = await Promise.all([
      import("./runtime/index.mjs"),
      import("./wasm/single/hypertok_wasm_core.js"),
      fetch("./vocab/o200k_base.htk"),
    ]);
    const vocabulary = new Uint8Array(await vocabularyResponse.arrayBuffer());
    const runtime = await fromBytes(vocabulary, { tier: "single" });
    await rawModule.default();
    const raw = rawModule.WasmTokenizer.fromHtk(vocabulary);
    try {
      const encodeRaw = (text) => {
        let remaining = text;
        let written = 0;
        while (remaining.length !== 0) {
          const view = raw.residentInputView();
          const encoded = encoder.encodeInto(remaining, view.subarray(written));
          written += encoded.written;
          if (encoded.read === remaining.length) break;
          remaining = remaining.slice(encoded.read);
          raw.growResidentInput();
        }
        return raw.encodeResidentInput(written);
      };
      const seed = "Exact browser tokenization measures the path a visitor runs. ";
      const rows = [];
      for (const targetBytes of [4_096, 65_536]) {
        const text = seed.repeat(Math.ceil(targetBytes / seed.length)).slice(0, targetBytes);
        const input = encoder.encode(text);
        const runtimeWindows = [];
        const rawWindows = [];
        let runtimeIds;
        let rawIds;
        const lanes = [
          () => { runtimeIds = runtime.encodeSync(text); },
          () => { rawIds = encodeRaw(text); },
        ];
        lanes[0]();
        lanes[1]();
        for (let round = 0; round < ROUNDS; round += 1) {
          const order = round % 2 === 0 ? [0, 1] : [1, 0];
          for (const lane of order) {
            const value = timeWindow(lanes[lane]);
            (lane === 0 ? runtimeWindows : rawWindows).push(value);
          }
        }
        if (runtimeIds.length !== rawIds.length) throw new Error("runtime and raw token counts differ");
        if (!runtimeIds.every((id, index) => id === rawIds[index])) {
          throw new Error("runtime and raw token ids differ");
        }
        const runtimeStats = stats(runtimeWindows);
        const rawStats = stats(rawWindows);
        const ratio = rawStats.timeMs / runtimeStats.timeMs;
        const driftBound = Math.max(ADOPTED_DRIFT, 2 * (runtimeStats.noise + rawStats.noise));
        rows.push({
          bytes: input.length,
          runtimeMs: runtimeStats.timeMs,
          rawMs: rawStats.timeMs,
          runtimeNoise: runtimeStats.noise,
          rawNoise: rawStats.noise,
          ratio,
          driftBound,
          exact: true,
        });
      }
      return { tier: runtime.tier, rows };
    } finally {
      raw.free();
      runtime.free();
    }
  });

  const verify = (result) => {
    assert.equal(result.tier, "single");
    for (const row of result.rows) {
      assert.equal(row.exact, true);
      assert.ok(
        row.ratio >= 1 - row.driftBound,
        `${row.bytes}-byte demo seam ratio ${row.ratio} falls below ${1 - row.driftBound}`,
      );
    }
  };
  console.log(JSON.stringify({ ...report, requestsLocal: requestUrls.length }, null, 2));
  verify(report);
  assert.throws(() => verify({ ...report, tier: "worker" }));
  assert.throws(() => verify({
    ...report,
    rows: report.rows.map((row, index) => index === 0 ? { ...row, ratio: 0.5, driftBound: 0.03 } : row),
  }));
  assert.ok(requestUrls.every((url) => new URL(url).origin === origin));
  console.log(JSON.stringify({ mutationsRed: 2 }, null, 2));
} finally {
  await browser?.close();
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}
