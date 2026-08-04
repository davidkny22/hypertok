import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const demoRoot = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(demoRoot, "../hypertok-js");
const require = createRequire(path.join(packageRoot, "package.json"));
const { chromium } = require("playwright-core");
const chromeCandidates = [
  process.env.CHROME_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
].filter(Boolean);
const executablePath = chromeCandidates.find((candidate) => existsSync(candidate));
const browser = await chromium.launch({
  headless: true,
  ...(executablePath ? { executablePath } : { channel: "chrome" }),
});
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
  await page.goto(pathToFileURL(path.join(demoRoot, "preview.svg")).href);
  const preview = page.locator("svg");
  const box = await preview.boundingBox();
  assert.deepEqual(box, { x: 0, y: 0, width: 1200, height: 630 });
  await preview.screenshot({ path: path.join(demoRoot, "preview.png") });
} finally {
  await browser.close();
}
