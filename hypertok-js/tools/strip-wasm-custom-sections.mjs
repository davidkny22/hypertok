import { readFile, writeFile } from "node:fs/promises";

function readU32(bytes, start) {
  let value = 0;
  let shift = 0;
  let offset = start;
  for (; offset < bytes.length && shift < 35; offset += 1, shift += 7) {
    const byte = bytes[offset];
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: value >>> 0, offset: offset + 1 };
  }
  throw new Error("invalid WebAssembly u32 LEB128 value");
}

function customName(bytes, payloadStart, payloadEnd) {
  const length = readU32(bytes, payloadStart);
  const end = length.offset + length.value;
  if (end > payloadEnd) throw new Error("custom section name exceeds its payload");
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(length.offset, end));
}

function shouldStrip(name) {
  return name === "name"
    || name === "producers"
    || name === "sourceMappingURL"
    || name === "external_debug_info"
    || name.startsWith(".debug_");
}

export function stripCustomSections(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length < 8 || bytes[0] !== 0 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) {
    throw new Error("input is not a WebAssembly binary");
  }
  const kept = [bytes.subarray(0, 8)];
  const removed = [];
  let offset = 8;
  while (offset < bytes.length) {
    const sectionStart = offset;
    const id = bytes[offset];
    offset += 1;
    const length = readU32(bytes, offset);
    const payloadStart = length.offset;
    const payloadEnd = payloadStart + length.value;
    if (payloadEnd > bytes.length) throw new Error("WebAssembly section exceeds the input");
    const name = id === 0 ? customName(bytes, payloadStart, payloadEnd) : null;
    if (name !== null && shouldStrip(name)) {
      removed.push({ name, bytes: payloadEnd - sectionStart });
    } else {
      kept.push(bytes.subarray(sectionStart, payloadEnd));
    }
    offset = payloadEnd;
  }
  const output = new Uint8Array(kept.reduce((sum, part) => sum + part.length, 0));
  let destination = 0;
  for (const part of kept) {
    output.set(part, destination);
    destination += part.length;
  }
  return { output, removed };
}

const [mode, ...files] = process.argv.slice(2);
if ((mode !== "--dry-run" && mode !== "--in-place") || files.length === 0) {
  throw new Error("usage: node strip-wasm-custom-sections.mjs --dry-run|--in-place FILE...");
}
for (const file of files) {
  const input = await readFile(file);
  const { output, removed } = stripCustomSections(input);
  if (mode === "--in-place" && output.length !== input.length) await writeFile(file, output);
  console.log(JSON.stringify({
    file,
    before: input.length,
    after: output.length,
    saved: input.length - output.length,
    removed,
    changed: output.length !== input.length,
    mode,
  }));
}
