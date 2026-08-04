import fs from "node:fs";
import { chromium } from "playwright-core";

const platformCandidates = Object.freeze({
  win32: [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ],
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ],
  linux: [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ],
});

function commandLineChromePath(args) {
  const index = args.indexOf("--chrome");
  if (index === -1) return null;
  if (index + 1 >= args.length || args[index + 1].startsWith("--")) {
    throw new Error("--chrome requires an executable path");
  }
  return args[index + 1];
}

export function resolveChromeExecutable({
  args = process.argv.slice(2),
  environment = process.env,
  platform = process.platform,
  exists = fs.existsSync,
} = {}) {
  const requested = commandLineChromePath(args) ?? environment.HYPERTOK_CHROME_PATH ?? null;
  if (requested !== null) {
    if (!exists(requested)) throw new Error(`Chrome executable not found: ${requested}`);
    return Object.freeze({ executablePath: requested, source: "explicit" });
  }
  const executablePath = (platformCandidates[platform] ?? []).find(exists);
  if (executablePath === undefined) {
    throw new Error(
      "Chrome was not found. Pass --chrome <path> or set HYPERTOK_CHROME_PATH",
    );
  }
  return Object.freeze({ executablePath, source: "discovered" });
}

export async function launchHarnessBrowser({
  args = process.argv.slice(2),
  browserArgs = [],
} = {}) {
  const resolution = resolveChromeExecutable({ args });
  const browser = await chromium.launch({
    executablePath: resolution.executablePath,
    headless: true,
    args: browserArgs,
  });
  return Object.freeze({
    browser,
    executablePath: resolution.executablePath,
    executableSource: resolution.source,
    browserVersion: browser.version(),
  });
}

export function observeRequests(page) {
  const urls = [];
  const failedUrls = [];
  page.on("request", (request) => urls.push(request.url()));
  page.on("requestfailed", (request) => failedUrls.push(request.url()));
  return Object.freeze({
    urls,
    failedUrls,
    assertLocal(origin) {
      if (failedUrls.length > 0) {
        throw new Error(`Browser run had ${failedUrls.length} failed requests`);
      }
      const external = urls.filter((url) => new URL(url).origin !== origin);
      if (external.length > 0) {
        throw new Error(`Browser run made ${external.length} non-local requests`);
      }
      return Object.freeze({ requestCount: urls.length, failedRequestCount: 0 });
    },
  });
}
