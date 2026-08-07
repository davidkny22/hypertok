import path from "node:path";
import { pathToFileURL } from "node:url";

const packageMode = process.argv[2] === "--package";
const moduleRoot = packageMode ? undefined : path.resolve(process.argv[2]);
const vocabularyPath = path.resolve(process.argv[3]);
let fetchCalls = 0;
globalThis.fetch = (...args) => {
  fetchCalls += 1;
  throw new Error(`unexpected fetch: ${String(args[0])}`);
};

const importFromRoot = (relative) => import(pathToFileURL(path.join(moduleRoot, relative)).href);
const [coreModule, tiktokenModule, huggingFaceModule, registryModule] = packageMode
  ? await Promise.all([
      import("hypertok"),
      import("hypertok/tiktoken"),
      import("hypertok/huggingface"),
      import("../../src/shim-runtime.mjs"),
    ])
  : await Promise.all([
      importFromRoot("src/index.mjs"),
      importFromRoot("src/tiktoken-shim.mjs"),
      importFromRoot("src/huggingface-shim.mjs"),
      importFromRoot("src/shim-runtime.mjs"),
    ]);

const bytes = new Uint8Array(await Bun.file(vocabularyPath).arrayBuffer());
const publicHandle = await coreModule.fromBytes(bytes);
const resident = registryModule.resolveShimRuntime(publicHandle);
const text = "Bun resident shim probe \u{1F469}\u{1F3FD}\u200D\u{1F4BB}";
const expected = Array.from(await publicHandle.encode(text));
let publicEncodeSyncError;
try {
  publicHandle.encodeSync(text);
} catch (error) {
  publicEncodeSyncError = error?.message;
}

const tiktoken = {};
let tiktokenShim;
try {
  tiktokenShim = tiktokenModule.createTiktokenShim(publicHandle, { name: "gpt2" });
  tiktoken.ids = Array.from(tiktokenShim.encode_ordinary(text));
  tiktoken.decoded = new TextDecoder().decode(tiktokenShim.decode(tiktoken.ids));
  tiktoken.ok = true;
} catch (error) {
  tiktoken.ok = false;
  tiktoken.name = error?.name;
  tiktoken.message = error?.message;
}

const huggingFace = {};
try {
  const shim = huggingFaceModule.createHuggingFaceShim(publicHandle, {
    tokenString(id) {
      return Number.isInteger(id) && id >= 0 && id < publicHandle.vocabSize ? String(id) : undefined;
    },
    postProcess(first, second) {
      const ids = second === null ? [...first] : [...first, ...second];
      return { ids, token_type_ids: ids.map(() => 0) };
    },
    specialTokens: [],
    unknownTokenId: 0,
    cleanUpTokenizationSpaces: false,
  });
  const encoded = shim.encode(text, {
    add_special_tokens: false,
    return_token_type_ids: false,
  });
  huggingFace.ids = encoded.ids;
  huggingFace.decoded = shim.decode(encoded.ids, { clean_up_tokenization_spaces: false });
  huggingFace.ok = true;
} catch (error) {
  huggingFace.ok = false;
  huggingFace.name = error?.name;
  huggingFace.message = error?.message;
}

const lifecycle = typeof resident?.lifecycle === "function" ? resident.lifecycle() : undefined;
let sameSessionClosed = false;
if (tiktokenShim !== undefined) {
  tiktokenShim.free();
  try {
    await publicHandle.encode("after shim free");
  } catch (error) {
    sameSessionClosed = /closed/.test(error?.message ?? "");
  }
} else {
  publicHandle.free();
}

const result = {
  bun: Bun.version,
  worker: typeof Worker,
  publicTier: publicHandle.tier,
  publicEncodeSyncError,
  expected,
  resolvedTier: resident?.tier,
  singleLoads: lifecycle?.singleLoads,
  residentSingleIdentity: lifecycle?.residentSingleIdentity,
  fetchCalls,
  tiktoken,
  huggingFace,
  sameSessionClosed,
};
console.log(JSON.stringify(result));

if (!tiktoken.ok || !huggingFace.ok) {
  process.exitCode = 23;
} else if (
  publicHandle.tier !== "worker"
  || !/worker tier/.test(publicEncodeSyncError ?? "")
  || resident?.tier !== "single"
  || lifecycle?.singleLoads !== 1
  || lifecycle?.residentSingleIdentity !== 1
  || fetchCalls !== 0
  || JSON.stringify(tiktoken.ids) !== JSON.stringify(expected)
  || tiktoken.decoded !== text
  || JSON.stringify(huggingFace.ids) !== JSON.stringify(expected)
  || huggingFace.decoded !== text
  || !sameSessionClosed
) {
  process.exitCode = 24;
}
