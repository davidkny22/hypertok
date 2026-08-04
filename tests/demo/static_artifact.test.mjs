import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const output = path.join(root, "results", "demo");

test("share preview decodes as the advertised image shape", async () => {
  const preview = await readFile(path.join(output, "preview.png"));
  assert.equal(preview.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(preview.readUInt32BE(16), 1200);
  assert.equal(preview.readUInt32BE(20), 630);
});
