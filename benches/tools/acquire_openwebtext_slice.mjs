import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const sourceRevision = "86886dcee6d92159ca7538222a8c7ff4c79aa336";
const sourceSha256 = "b19ae88cfbc4016b304c348522455fe38ebac48fffed955adcc7191a89e38ccf";
const sourceBytes = 4_591_240_837;
const targetBytes = 50_000_000;
const expectedSliceSha256 = "6726c86a0fad3f2f16233ed00008c606f6a46141787bb1a7e475f55a983319e7";
const expectedCompressedSha256 = "3e3a13df9a01903acc3824a1cd5ec823c124ce4468aa85fe2da7b107f1b3ddee";
const documentSeparator = new TextEncoder().encode("<|endoftext|>");
const repositoryUrl = "https://huggingface.co/datasets/stanford-cs336/owt-sample";
const pointerUrl = `${repositoryUrl}/raw/${sourceRevision}/owt_train.txt.gz`;
const downloadUrl = `${repositoryUrl}/resolve/${sourceRevision}/owt_train.txt.gz`;
const outputPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "corpus",
  "openwebtext-slice.txt.gz",
);

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function normalizedPrefix(bytes) {
  const output = new Uint8Array(targetBytes + 4);
  let inputIndex = 0;
  let outputIndex = 0;
  while (outputIndex < output.length && inputIndex < bytes.length) {
    let separator = inputIndex + documentSeparator.length <= bytes.length;
    for (let index = 0; separator && index < documentSeparator.length; index += 1) {
      separator = bytes[inputIndex + index] === documentSeparator[index];
    }
    if (separator) {
      output[outputIndex] = 0x0a;
      outputIndex += 1;
      inputIndex += documentSeparator.length;
    } else {
      output[outputIndex] = bytes[inputIndex];
      outputIndex += 1;
      inputIndex += 1;
    }
  }
  if (outputIndex < output.length) {
    throw new Error("OpenWebText source prefix is too short after separator normalization");
  }
  let end = targetBytes;
  while (end < outputIndex && (output[end] & 0xc0) === 0x80) end += 1;
  const prefix = output.subarray(0, end);
  new TextDecoder("utf-8", { fatal: true }).decode(prefix);
  return prefix;
}

const pointerResponse = await fetch(pointerUrl, { redirect: "follow" });
if (!pointerResponse.ok) {
  throw new Error(`OpenWebText pointer HTTP ${pointerResponse.status}`);
}
const pointer = await pointerResponse.text();
if (
  !pointer.includes(`oid sha256:${sourceSha256}`) ||
  !pointer.includes(`size ${sourceBytes}`)
) {
  throw new Error("OpenWebText source pointer does not match the pinned digest and size");
}

const response = await fetch(downloadUrl, { redirect: "follow" });
if (!response.ok || response.body === null) {
  throw new Error(`OpenWebText download HTTP ${response.status}`);
}
const reader = response.body
  .pipeThrough(new DecompressionStream("gzip"))
  .getReader();
const chunks = [];
let received = 0;
while (received < targetBytes + 2_000_000) {
  const { value, done } = await reader.read();
  if (done) break;
  chunks.push(value);
  received += value.length;
}
await reader.cancel();
if (received < targetBytes + 2_000_000) {
  throw new Error(`OpenWebText source ended at ${received} decompressed bytes`);
}

const joined = new Uint8Array(received);
let offset = 0;
for (const chunk of chunks) {
  joined.set(chunk, offset);
  offset += chunk.length;
}
const slice = normalizedPrefix(joined);
const compressed = gzipSync(slice, { level: 9 });
if (
  (expectedSliceSha256 !== null && sha256(slice) !== expectedSliceSha256) ||
  (expectedCompressedSha256 !== null && sha256(compressed) !== expectedCompressedSha256)
) {
  throw new Error("OpenWebText slice does not match the pinned output digests");
}
const force = process.argv.includes("--force");
if (fs.existsSync(outputPath) && !force) {
  throw new Error(`Refusing to overwrite existing corpus slice: ${outputPath}`);
}
fs.writeFileSync(outputPath, compressed, { flag: force ? "w" : "wx" });

console.log(JSON.stringify({
  sourceRevision,
  sourceSha256,
  sourceBytes,
  targetBytes,
  sliceBytes: slice.length,
  sliceSha256: sha256(slice),
  compressedBytes: compressed.length,
  compressedSha256: sha256(compressed),
  outputPath,
}, null, 2));
