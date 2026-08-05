import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const output = path.join(root, "results", "demo");
const packageRoot = path.join(root, "hypertok-js");
const require = createRequire(path.join(packageRoot, "package.json"));
const { chromium } = require("playwright-core");
const axePath = require.resolve("axe-core/axe.min.js");
const budgets = JSON.parse(await readFile(path.join(output, "budgets.json"), "utf8"));

function verifyMetadata(metadata) {
  assert.equal(metadata.title, "hypertok");
  assert.match(metadata.description, /hypertok/i);
  assert.equal(metadata.ogType, "website");
  assert.equal(metadata.ogUrl, "./");
  assert.equal(metadata.ogTitle, "hypertok");
  assert.match(metadata.ogDescription, /tokenization/i);
  assert.equal(metadata.ogImage, "./preview.png");
  assert.match(metadata.ogImageAlt, /hypertok/i);
  assert.equal(metadata.twitterCard, "summary_large_image");
  assert.equal(metadata.twitterImage, "./preview.png");
  assert.match(metadata.twitterImageAlt, /hypertok/i);
  assert.equal(metadata.canonical, "./");
}

const TIME_BUDGET_SCALE = Math.max(1, Number(process.env.HYPERTOK_CI_BUDGET_SCALE) || 1);

function verifyBudgets(metrics, limits) {
  for (const [name, value] of Object.entries(limits)) {
    assert.ok(Number.isSafeInteger(value) && value >= 0, `${name} must be a non-negative integer`);
  }
  const maxDom = limits.maxDomContentLoadedMs * TIME_BUDGET_SCALE;
  const maxReady = limits.maxReadyMs * TIME_BUDGET_SCALE;
  assert.ok(
    metrics.domContentLoadedMs <= maxDom,
    `DOMContentLoaded ${metrics.domContentLoadedMs} ms exceeds ${maxDom} ms`,
  );
  assert.ok(metrics.readyMs <= maxReady, `ready ${metrics.readyMs} ms exceeds ${maxReady} ms`);
  assert.ok(
    metrics.initialResponseBytes <= limits.maxInitialResponseBytes,
    `initial responses ${metrics.initialResponseBytes} bytes exceed ${limits.maxInitialResponseBytes}`,
  );
  assert.ok(
    metrics.initialRequests <= limits.maxInitialRequests,
    `initial requests ${metrics.initialRequests} exceed ${limits.maxInitialRequests}`,
  );
  assert.ok(metrics.shellBytes <= limits.maxShellBytes, `shell ${metrics.shellBytes} bytes exceeds ${limits.maxShellBytes}`);
  assert.ok(
    metrics.accessibilityViolations <= limits.maxAccessibilityViolations,
    `accessibility violations ${metrics.accessibilityViolations} exceed ${limits.maxAccessibilityViolations}`,
  );
  assert.ok(
    metrics.externalRequests <= limits.maxExternalRequests,
    `external requests ${metrics.externalRequests} exceed ${limits.maxExternalRequests}`,
  );
}

const mimeTypes = Object.freeze({
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".htk": "application/octet-stream",
});

const responses = [];
const notFound = [];
let trackInitial = true;
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const filePath = path.resolve(output, relative);
    const outputPrefix = `${path.resolve(output)}${path.sep}`;
    if (!filePath.startsWith(outputPrefix)) throw new Error("request escaped demo output");
    const bytes = await readFile(filePath);
    response.writeHead(200, {
      "Content-Type": mimeTypes[path.extname(filePath)] ?? "application/octet-stream",
      "Content-Length": bytes.length,
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Cache-Control": "no-store",
    });
    response.end(bytes);
    if (trackInitial) responses.push({ relative, bytes: bytes.length });
  } catch (error) {
    notFound.push(request.url);
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

const requests = [];
const pageErrors = [];
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : { channel: "chrome" }),
  });
  const page = await browser.newPage();
  page.on("request", (request) => requests.push({ url: request.url(), body: request.postData() ?? "" }));
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(origin, { waitUntil: "domcontentloaded", timeout: 15_000 });
  await page.waitForFunction(
    () => document.querySelector("#receipt")?.textContent.includes("ready in"),
    undefined,
    { timeout: 15_000 },
  );
  const timing = await page.evaluate(() => {
    const navigation = performance.getEntriesByType("navigation")[0];
    return {
      domContentLoadedMs: Math.ceil(navigation.domContentLoadedEventEnd),
      readyMs: Math.ceil(performance.now()),
    };
  });
  trackInitial = false;

  const metadata = await page.evaluate(() => {
    const content = (selector) => document.querySelector(selector)?.getAttribute("content") ?? "";
    return {
      title: document.title,
      description: content('meta[name="description"]'),
      ogType: content('meta[property="og:type"]'),
      ogUrl: content('meta[property="og:url"]'),
      ogTitle: content('meta[property="og:title"]'),
      ogDescription: content('meta[property="og:description"]'),
      ogImage: content('meta[property="og:image"]'),
      ogImageAlt: content('meta[property="og:image:alt"]'),
      twitterCard: content('meta[name="twitter:card"]'),
      twitterImage: content('meta[name="twitter:image"]'),
      twitterImageAlt: content('meta[name="twitter:image:alt"]'),
      canonical: document.querySelector('link[rel="canonical"]')?.getAttribute("href") ?? "",
    };
  });
  verifyMetadata(metadata);

  const structure = await page.evaluate(() => {
    const ids = [...document.querySelectorAll("[id]")].map((element) => element.id);
    const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index);
    const unnamedButtons = [...document.querySelectorAll("button")].filter(
      (button) => !(button.getAttribute("aria-label") || button.textContent.trim()),
    ).length;
    return {
      language: document.documentElement.lang,
      headings: document.querySelectorAll("h1").length,
      mainLandmarks: document.querySelectorAll("main").length,
      unnamedButtons,
      duplicateIds: duplicateIds.length,
      editorName: document.querySelector('[role="textbox"]')?.getAttribute("aria-label") ?? "",
    };
  });
  assert.deepEqual(structure, {
    language: "en",
    headings: 1,
    mainLandmarks: 1,
    unnamedButtons: 0,
    duplicateIds: 0,
    editorName: "text to tokenize",
  });

  await page.addScriptTag({ path: axePath });
  const accessibility = await page.evaluate(async () =>
    globalThis.axe.run(document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
    }),
  );

  const shellFiles = ["index.html", "app.mjs", "span-map.mjs", "preview.svg"];
  const shellSizes = await Promise.all(shellFiles.map(async (name) => (await stat(path.join(output, name))).size));
  const initialFiles = responses.map((response) => response.relative);
  assert.ok(initialFiles.includes("fonts/MartianMono.ttf"));
  assert.ok(initialFiles.includes("vocab/gpt2.htk"));
  assert.ok(initialFiles.includes("wasm/single/hypertok_wasm_core_bg.wasm"));
  assert.ok(initialFiles.every((name) => !name.startsWith("incumbents/")));
  assert.ok(initialFiles.every((name) => !name.startsWith("wasm/shared/")));
  assert.ok(initialFiles.every((name) => !name.startsWith("vocab/") || name === "vocab/gpt2.htk"));
  const externalRequests = requests.filter((request) => new URL(request.url).origin !== origin);
  const metrics = {
    ...timing,
    initialResponseBytes: responses.reduce((sum, item) => sum + item.bytes, 0),
    initialRequests: responses.length,
    shellBytes: shellSizes.reduce((sum, value) => sum + value, 0),
    accessibilityViolations: accessibility.violations.length,
    externalRequests: externalRequests.length,
  };
  verifyBudgets(metrics, budgets);
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(notFound, []);

  await page.getByRole("button", { name: "english" }).click();
  try {
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll("#race .match")].some((element) =>
          element.textContent?.startsWith("outputs match:"),
        ),
      undefined,
      { timeout: 15_000 },
    );
  } catch (error) {
    const state = await page.evaluate(() => ({
      race: document.querySelector("#race")?.textContent ?? "",
      lanes: [...document.querySelectorAll("#race .lane-name")].map((element) => element.textContent),
    }));
    throw new Error(`initial race did not finish: ${JSON.stringify({ state, pageErrors, notFound })}`, { cause: error });
  }
  const initialRace = await page.evaluate(() => ({
    lanes: [...document.querySelectorAll("#race .lane-name")].map((element) => element.textContent),
    match:
      [...document.querySelectorAll("#race .match")].find((element) =>
        element.textContent?.startsWith("outputs match:"),
      )?.textContent ?? "",
  }));
  assert.deepEqual(initialRace.lanes, [
    "hypertok",
    "js-tiktoken",
    "gpt-tokenizer",
    "@dqbd/tiktoken",
    "hf tokenizers",
  ]);
  assert.match(initialRace.match, /^outputs match: \d+ tokens identical$/);
  assert.ok(requests.some((request) => request.url.includes("/incumbents/js-tiktoken-gpt2.mjs")));

  await page.waitForFunction(() => document.querySelector("#status")?.textContent.includes("tokens"));
  const liveInteraction = await page.evaluate(() => ({
    input: document.querySelector("#input")?.innerText,
    painted: document.querySelector("#paint")?.textContent,
    paintedTokens: document.querySelectorAll("#paint span[data-id]").length,
  }));
  assert.equal(liveInteraction.painted, liveInteraction.input);
  assert.ok(liveInteraction.paintedTokens > 0);
  const firstToken = page.locator("#paint span[data-id]").first();
  const tokenBox = await firstToken.boundingBox();
  assert.ok(tokenBox);
  await page.mouse.move(tokenBox.x + tokenBox.width / 2, tokenBox.y + tokenBox.height / 2);
  await page.waitForFunction(() => document.querySelector("#chip")?.textContent.startsWith("id "));
  const tooltip = await page.locator("#chip").textContent();
  assert.match(tooltip, /^id \d+$/);

  const userTextMarker = "USER_TEXT_MUST_STAY_LOCAL_7f41c2";
  await page.locator("#input").evaluate((element, marker) => {
    element.textContent = marker;
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: marker }));
  }, userTextMarker);
  await page.waitForFunction((marker) => document.querySelector("#paint")?.textContent === marker, userTextMarker);
  assert.ok(requests.every((request) => !request.url.includes(userTextMarker) && !request.body.includes(userTextMarker)));

  await page.getByRole("button", { name: "gpt-2" }).click();
  await page.waitForFunction(() => document.querySelector("#receipt")?.textContent.startsWith("o200k"));
  try {
    await page.waitForFunction(() => document.querySelector("#receipt")?.textContent.includes("ready in"), undefined, {
      timeout: 15_000,
    });
  } catch (error) {
    const state = await page.evaluate(() => ({
      receipt: document.querySelector("#receipt")?.textContent,
      status: document.querySelector("#status")?.textContent,
    }));
    throw new Error(`vocabulary switch did not become ready: ${JSON.stringify({ state, pageErrors })}`, {
      cause: error,
    });
  }
  assert.ok(await page.locator("#paint span[data-id]").count());
  assert.equal(requests.filter((request) => new URL(request.url).origin !== origin).length, 0);

  const tierFallback = await page.evaluate(async () => {
    const { fromBytes } = await import("./runtime/index.mjs");
    const vocabulary = new Uint8Array(await (await fetch("./vocab/qwen3.6.htk")).arrayBuffer());
    const automatic = await fromBytes(vocabulary, { tier: "auto", workers: 2 });
    const automaticResult = {
      tier: automatic.tier,
    };
    automatic.free();
    let explicitError = "";
    try {
      const explicit = await fromBytes(vocabulary, { tier: "shared", workers: 2 });
      explicit.free();
    } catch (error) {
      explicitError = error instanceof Error ? error.message : String(error);
    }
    return { automatic: automaticResult, explicitError };
  });
  assert.equal(tierFallback.automatic.tier, "single");
  assert.match(tierFallback.explicitError, /compatible \.htk source/);
  assert.equal(requests.filter((request) => new URL(request.url).origin !== origin).length, 0);

  let mutationsRed = 0;
  assert.throws(() => verifyMetadata({ ...metadata, ogImage: "" }));
  mutationsRed += 1;
  assert.throws(() => verifyBudgets({ ...metrics, readyMs: (budgets.maxReadyMs + 1) * TIME_BUDGET_SCALE }, budgets));
  mutationsRed += 1;
  const mutationStyle = await page.addStyleTag({ content: ":root { --quiet: #10131b !important; }" });
  const contrastMutation = await page.evaluate(async () =>
    globalThis.axe.run(document, { runOnly: { type: "rule", values: ["color-contrast"] } }),
  );
  await mutationStyle.evaluate((element) => element.remove());
  assert.ok(contrastMutation.violations.some((violation) => violation.id === "color-contrast"));
  mutationsRed += 1;

  console.log(
    JSON.stringify(
      {
        metrics,
        budgets,
        accessibilityPasses: accessibility.passes.length,
        initialFiles,
        requestsLocal: requests.length,
        liveInteraction: { paintedTokens: liveInteraction.paintedTokens, tooltip, switchReady: true },
        initialRace,
        userTextStayedLocal: true,
        tierFallback,
        mutationsRed,
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
