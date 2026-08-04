import { loadReferencePayload } from "./node/payload_measurement.mjs";
import { summarize } from "./common/timing.mjs";

const [slug, vocabulary, nText] = process.argv.slice(2);
const n = Number(nText);
if (slug === undefined || vocabulary === undefined || !Number.isInteger(n) || n < 1) {
  throw new Error("usage: measure_node_load_worker.mjs <slug> <vocabulary> <n>");
}
const transfer = [];
const decompression = [];
const materialisation = [];
let reference;
let version;
let compressedBytes;
let decompressedBytes;

for (let index = 0; index < n; index += 1) {
  const { adapter, measurement } = await loadReferencePayload(slug, vocabulary);
  reference = measurement.reference;
  version = measurement.version;
  compressedBytes = measurement.compressedBytes;
  decompressedBytes = measurement.decompressedBytes;
  transfer.push(measurement.transferMilliseconds);
  decompression.push(measurement.decompressionMilliseconds);
  materialisation.push(measurement.materialisationMilliseconds);
  adapter.dispose();
}

process.stdout.write(
  `${JSON.stringify({
    reference,
    vocabulary,
    referenceVersion: version,
    compressedBytes,
    decompressedBytes,
    transfer: { ...summarize(transfer), units: "ms" },
    decompression: { ...summarize(decompression), units: "ms" },
    materialisation: { ...summarize(materialisation), units: "ms" },
  })}\n`,
);
