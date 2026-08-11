import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [runtimePath, wasmPath, vocabularyPath, mode] = process.argv.slice(2);
if (!runtimePath || !wasmPath || !vocabularyPath || !["exact", "mutation"].includes(mode)) {
  throw new Error("usage: prebuilt_public_sample.mjs runtime wasm vocabulary exact|mutation");
}

const runtime = await import(pathToFileURL(path.resolve(runtimePath)).href);
const wasm = new Uint8Array(fs.readFileSync(wasmPath));
const vocabulary = new Uint8Array(fs.readFileSync(vocabularyPath));
if (mode === "mutation") {
  try {
    const tokenizer = await runtime.fromBytes(digestValidPairMutation(vocabulary), {
      tier: "single",
      moduleSource: wasm,
    });
    tokenizer.free();
    throw new Error("digest-valid pair corruption was accepted");
  } catch (error) {
    if (error?.message === "digest-valid pair corruption was accepted") throw error;
    process.stdout.write(`${JSON.stringify({ error: String(error?.message ?? error) })}\n`);
  }
} else {
  const tokenizer = await runtime.fromBytes(vocabulary, { tier: "single", moduleSource: wasm });
  try {
    const cases = [
      "Plain prose with punctuation.",
      "const answer = (x) => x * 42;\n",
      "\u4e2d\u6587\u3068\u65e5\u672c\u8a9e",
      "\ud83d\udc69\ud83c\udffd\u200d\ud83d\udcbb\ud83d\ude80",
      " \t\n\n\ufeff boundary ",
    ].map((text) => {
      const ids = tokenizer.encodeSync(text);
      return { ids: [...ids], decoded: tokenizer.decode(ids) };
    });
    process.stdout.write(`${JSON.stringify({ cases })}\n`);
  } finally {
    tokenizer.free();
  }
}

function digestValidPairMutation(source) {
  const bytes = new Uint8Array(source);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sectionCount = view.getUint32(24, true);
  const tableOffset = view.getUint32(28, true);
  let pairOffset;
  let pairLength;
  for (let index = 0; index < sectionCount; index += 1) {
    const entry = tableOffset + index * 16;
    if (view.getUint32(entry, true) === 1025) {
      pairOffset = view.getUint32(entry + 4, true);
      pairLength = Number(view.getBigUint64(entry + 8, true));
      break;
    }
  }
  if (pairOffset === undefined || pairLength < 72) {
    throw new Error("candidate has no populated prebuilt pair section");
  }
  bytes[pairOffset + 64] ^= 1;
  bytes.set(digest(bytes.subarray(pairOffset, pairOffset + pairLength)), pairOffset + 32);
  bytes.set(digest(bytes), 32);
  return bytes;
}

function digest(bytes) {
  const hash = crypto.createHash("sha256");
  hash.update(bytes.subarray(0, 32));
  hash.update(Buffer.alloc(32));
  hash.update(bytes.subarray(64));
  return hash.digest();
}
