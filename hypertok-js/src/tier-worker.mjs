let tokenizer;
let workerId;

function response(id, value, transfer = []) {
  self.postMessage({ id, ok: true, value }, transfer);
}

function failure(id, error) {
  self.postMessage({
    id,
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  });
}

self.addEventListener("message", async (event) => {
  const { id, operation } = event.data;
  try {
    if (operation === "initialize") {
      const { moduleUrl, vocabulary, scheme, format, workerImage, sourceDigest } = event.data;
      workerId = event.data.workerId;
      const module = await import(/* webpackIgnore: true */ /* @vite-ignore */ moduleUrl);
      await module.default();
      const imported = format === "htk";
      tokenizer = imported
        ? module.WasmTransferredTokenizer.fromWorkerImage(
            new Uint8Array(workerImage),
            new Uint8Array(sourceDigest),
          )
        : module.WasmTokenizer.fromTiktoken(new Uint8Array(vocabulary), scheme);
      response(id, {
        workerId,
        vocabSize: tokenizer.vocabSize(),
        imported,
        sourceDigest: imported ? tokenizer.sourceDigest() : [],
      });
      return;
    }
    if (operation === "encodePretokens") {
      if (tokenizer === undefined) throw new Error("worker tokenizer is not initialized");
      const input = new Uint8Array(event.data.input);
      const ranges = new Uint32Array(event.data.ranges);
      if (ranges.length % 2 !== 0) throw new Error("worker pretoken ranges are not paired");
      const encoded = [];
      for (let index = 0; index < ranges.length; index += 2) {
        encoded.push(tokenizer.encodePretoken(input.subarray(ranges[index], ranges[index + 1])));
      }
      const lengths = Uint32Array.from(encoded, (ids) => ids.length);
      const total = encoded.reduce((sum, ids) => sum + ids.length, 0);
      const flatIds = new Uint32Array(total);
      let offset = 0;
      for (const ids of encoded) {
        flatIds.set(ids, offset);
        offset += ids.length;
      }
      response(id, { flatIds, lengths, workerId }, [flatIds.buffer, lengths.buffer]);
      return;
    }
    if (operation === "close") {
      tokenizer?.free();
      tokenizer = undefined;
      response(id, null);
      return;
    }
    throw new Error(`unknown tier-worker operation ${operation}`);
  } catch (error) {
    failure(id, error);
  }
});
