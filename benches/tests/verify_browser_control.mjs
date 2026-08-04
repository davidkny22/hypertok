import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  observeRequests,
  resolveChromeExecutable,
} from "../browser/control.mjs";

const knownPath = "/known/chrome";
assert.equal(
  resolveChromeExecutable({
    args: ["--chrome", knownPath],
    environment: {},
    platform: "linux",
    exists: (candidate) => candidate === knownPath,
  }).executablePath,
  knownPath,
);
assert.equal(
  resolveChromeExecutable({
    args: [],
    environment: { HYPERTOK_CHROME_PATH: knownPath },
    platform: "linux",
    exists: (candidate) => candidate === knownPath,
  }).source,
  "explicit",
);
assert.throws(
  () => resolveChromeExecutable({ args: ["--chrome"], environment: {}, exists: () => false }),
  /requires an executable path/,
);
assert.throws(
  () => resolveChromeExecutable({ args: [], environment: {}, platform: "other", exists: () => false }),
  /Chrome was not found/,
);

const page = new EventEmitter();
const ledger = observeRequests(page);
page.emit("request", { url: () => "http://127.0.0.1:4000/a" });
assert.deepEqual(ledger.assertLocal("http://127.0.0.1:4000"), {
  requestCount: 1,
  failedRequestCount: 0,
});
page.emit("request", { url: () => "https://example.com/b" });
assert.throws(() => ledger.assertLocal("http://127.0.0.1:4000"), /non-local/);

console.log("Chrome resolution PASS (2/2 explicit paths, 2/2 refusals)");
console.log("request ledger PASS (local control and external mutation RED)");
