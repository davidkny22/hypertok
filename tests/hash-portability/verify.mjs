import { readFile } from "node:fs/promises";
import process from "node:process";

if (process.argv.length !== 5) {
  throw new Error("usage: node verify.mjs WASM IMAGE INPUTS");
}

const [wasmPath, imagePath, inputsPath] = process.argv.slice(2);
const [wasmBytes, imageBytes, inputBytes] = await Promise.all([
  readFile(wasmPath),
  readFile(imagePath),
  readFile(inputsPath),
]);
if (!WebAssembly.validate(wasmBytes)) {
  throw new Error("WebAssembly validation failed");
}
const { instance } = await WebAssembly.instantiate(wasmBytes);
const api = instance.exports;
for (const name of [
  "memory",
  "image_ptr",
  "image_len",
  "inputs_ptr",
  "inputs_len",
  "verify",
  "verify_truncated",
  "verify_misses",
]) {
  if (!(name in api)) throw new Error(`missing WebAssembly export ${name}`);
}

function imageView() {
  return new Uint8Array(api.memory.buffer, api.image_ptr(), api.image_len());
}

function inputsView() {
  return new Uint8Array(api.memory.buffer, api.inputs_ptr(), api.inputs_len());
}

const image = imageView();
const inputs = inputsView();
if (!Buffer.from(image).equals(imageBytes)) {
  throw new Error("WebAssembly image bytes differ from the host fixture");
}
if (!Buffer.from(inputs).equals(inputBytes)) {
  throw new Error("WebAssembly input bytes differ from the host fixture");
}
if (api.verify() !== 0) throw new Error("cross-architecture evaluation mismatch");
if (api.verify_truncated() !== 0) throw new Error("truncation negative control stayed green");
if (api.verify_misses() !== 0) throw new Error("miss bound check failed");

function mutationMustFail(offset, mask, name) {
  const original = imageView()[offset];
  imageView()[offset] = original ^ mask;
  const observed = api.verify();
  imageView()[offset] = original;
  if (observed === 0) throw new Error(`${name} mutation stayed green`);
  if (api.verify() !== 0) throw new Error(`${name} mutation did not revert cleanly`);
}

mutationMustFail(0, 1, "magic");
mutationMustFail(9, 1, "reserved field");
const currentImage = imageView();
const view = new DataView(currentImage.buffer, currentImage.byteOffset, currentImage.byteLength);
const levelCount = view.getUint32(16, true);
const bitWordsOffset = 32 + levelCount * 4;
mutationMustFail(bitWordsOffset, 1, "bit word");

console.log(JSON.stringify({
  status: "PASS",
  imageBytes: imageView().byteLength,
  inputBytes: inputsView().byteLength,
  keyCount: new DataView(api.memory.buffer, api.inputs_ptr(), api.inputs_len()).getUint32(0, true),
  mutationsObservedRed: 3,
  truncatedObservedRed: true,
  missChecks: 16384,
}));
