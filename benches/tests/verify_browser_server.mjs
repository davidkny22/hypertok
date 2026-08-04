import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startHarnessServer } from "../browser/server.mjs";

const benchesDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = path.join(benchesDirectory, "corpus", "script-latin.txt");
const pageContent = "<!doctype html><title>custom harness</title>";
const server = await startHarnessServer({
  pageContent,
  additionalRoutes: new Map([
    ["/fixture", [fixture, "text/plain; charset=utf-8"]],
  ]),
});
try {
  assert.equal(await (await fetch(server.origin)).text(), pageContent);
  assert.equal((await fetch(`${server.origin}/fixture`)).status, 200);
} finally {
  await server.close();
}

await assert.rejects(
  startHarnessServer({ additionalRoutes: new Map([["/bundle.mjs", [fixture, "text/plain"]]]) }),
  /Invalid or duplicate harness route/,
);
await assert.rejects(
  startHarnessServer({ additionalRoutes: new Map([["/blank", [fixture, "text/plain"]]]) }),
  /Invalid or duplicate harness route/,
);
await assert.rejects(
  startHarnessServer({ additionalRoutes: new Map([["fixture", [fixture, "text/plain"]]]) }),
  /Invalid or duplicate harness route/,
);

console.log("custom browser server PASS (page and route)");
console.log("server route mutations RED (duplicate, reserved, and invalid path)");
