import fs from "node:fs";
import { brotliCompressSync, constants as zlibConstants } from "node:zlib";

const arguments_ = process.argv.slice(2);
const outputIndex = arguments_.indexOf("--output");
const outputPath = outputIndex === -1 ? undefined : arguments_[outputIndex + 1];
if (outputIndex !== -1) arguments_.splice(outputIndex, 2);
const inputs = arguments_;
if (inputs.length === 0) {
  throw new Error("usage: price_compact_replay_forms.mjs <prebuilt-pair.htk> [...]");
}

const PAIR_SECTION_ID = 1025;
const PAIR_HEADER_BYTES = 64;
const CANDIDATE_HEADER_BYTES = 64;
const ID_BITS = 21n;
const ID_MASK = (1n << ID_BITS) - 1n;

const rows = inputs.map((input) => {
  const vocabulary = new Uint8Array(fs.readFileSync(input));
  const section = findSection(vocabulary, PAIR_SECTION_ID);
  const entries = parsePackedEntries(section).sort((left, right) => left.merged - right.merged);
  assertUniqueMergedIds(entries);

  const forms = [
    encodeFixedRows(entries),
    encodeVarintRows(entries),
    encodeMergedDistanceRows(entries),
    encodeMergedDistanceColumns(entries),
    encodeSuccessiveDeltaColumns(entries),
  ].map(({ id, payload }) => {
    const candidate = Buffer.alloc(CANDIDATE_HEADER_BYTES + payload.length);
    payload.copy(candidate, CANDIDATE_HEADER_BYTES);
    return {
      id,
      payloadBytes: payload.length,
      sectionBytes: candidate.length,
      sectionBrotliBytes: brotliCompressSync(candidate, {
        params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 },
      }).length,
    };
  });

  return {
    input,
    vocabularyBytes: vocabulary.byteLength,
    entryCount: entries.length,
    forms,
  };
});

const output = `${JSON.stringify({ schemaVersion: 1, rows }, null, 2)}\n`;
if (outputPath === undefined) {
  process.stdout.write(output);
} else {
  fs.writeFileSync(outputPath, output);
}

function findSection(bytes, sectionId) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sectionCount = view.getUint32(24, true);
  const tableOffset = view.getUint32(28, true);
  for (let index = 0; index < sectionCount; index += 1) {
    const entry = tableOffset + index * 16;
    if (view.getUint32(entry, true) !== sectionId) continue;
    const offset = view.getUint32(entry + 4, true);
    const length = Number(view.getBigUint64(entry + 8, true));
    return bytes.subarray(offset, offset + length);
  }
  throw new Error(`section ${sectionId} is absent`);
}

function parsePackedEntries(section) {
  if (section.byteLength < PAIR_HEADER_BYTES) throw new Error("pair section is truncated");
  if (new TextDecoder().decode(section.subarray(0, 4)) !== "HTKP") {
    throw new Error("pair section has the wrong magic");
  }
  const view = new DataView(section.buffer, section.byteOffset, section.byteLength);
  const entryCount = view.getUint32(12, true);
  if (section.byteLength !== PAIR_HEADER_BYTES + entryCount * 8) {
    throw new Error("pair section length does not match its entry count");
  }
  return Array.from({ length: entryCount }, (_, index) => {
    const packed = view.getBigUint64(PAIR_HEADER_BYTES + index * 8, true);
    const merged = Number(packed & ID_MASK);
    const key = packed >> ID_BITS;
    return {
      left: Number(key >> ID_BITS),
      right: Number(key & ID_MASK),
      merged,
    };
  });
}

function assertUniqueMergedIds(entries) {
  for (let index = 1; index < entries.length; index += 1) {
    if (entries[index - 1].merged >= entries[index].merged) {
      throw new Error("pair entries do not have unique increasing merged ids");
    }
  }
}

function encodeFixedRows(entries) {
  const payload = Buffer.alloc(entries.length * 8);
  entries.forEach((entry, index) => {
    payload.writeUInt32LE(entry.left, index * 8);
    payload.writeUInt32LE(entry.right, index * 8 + 4);
  });
  return { id: "fixed-u32-row", payload };
}

function encodeVarintRows(entries) {
  return {
    id: "varint-id-row",
    payload: Buffer.from(entries.flatMap(({ left, right }) => [
      ...encodeUnsigned(left),
      ...encodeUnsigned(right),
    ])),
  };
}

function encodeMergedDistanceRows(entries) {
  return {
    id: "varint-merged-distance-row",
    payload: Buffer.from(entries.flatMap(({ left, right, merged }) => [
      ...encodeUnsigned(merged - left),
      ...encodeUnsigned(merged - right),
    ])),
  };
}

function encodeMergedDistanceColumns(entries) {
  return {
    id: "varint-merged-distance-column",
    payload: Buffer.from([
      ...entries.flatMap(({ left, merged }) => encodeUnsigned(merged - left)),
      ...entries.flatMap(({ right, merged }) => encodeUnsigned(merged - right)),
    ]),
  };
}

function encodeSuccessiveDeltaColumns(entries) {
  let previousLeft = 0;
  let previousRight = 0;
  const left = [];
  const right = [];
  for (const entry of entries) {
    left.push(...encodeUnsigned(zigZag(entry.left - previousLeft)));
    right.push(...encodeUnsigned(zigZag(entry.right - previousRight)));
    previousLeft = entry.left;
    previousRight = entry.right;
  }
  return { id: "varint-successive-delta-column", payload: Buffer.from([...left, ...right]) };
}

function zigZag(value) {
  return value >= 0 ? value * 2 : -value * 2 - 1;
}

function encodeUnsigned(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("invalid unsigned value");
  const bytes = [];
  do {
    const next = value % 128;
    value = Math.floor(value / 128);
    bytes.push(next | (value === 0 ? 0 : 0x80));
  } while (value !== 0);
  return bytes;
}
