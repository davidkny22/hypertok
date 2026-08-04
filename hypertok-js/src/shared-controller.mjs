let tokenizer;

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
      const {
        moduleUrl,
        vocabulary,
        scheme,
        format,
        workerImage,
        sourceDigest,
        workerCount,
      } = event.data;
      const module = await import(/* webpackIgnore: true */ /* @vite-ignore */ moduleUrl);
      await module.default();
      await module.initThreadPool(workerCount);
      const imported = format === "htk";
      tokenizer = imported
        ? module.ThreadedWasmTokenizer.fromWorkerImage(
            new Uint8Array(workerImage),
            new Uint8Array(sourceDigest),
            workerCount,
          )
        : module.ThreadedWasmTokenizer.fromTiktoken(
            new Uint8Array(vocabulary),
            scheme,
            workerCount,
          );
      response(id, {
        workerCount: tokenizer.workerCount(),
        vocabSize: tokenizer.vocabSize(),
        imported: tokenizer.importedWorkerImage(),
        sourceDigest: tokenizer.sourceDigest(),
      });
      return;
    }
    if (operation === "encode") {
      if (tokenizer === undefined) throw new Error("shared controller is not initialized");
      const ids = tokenizer.encode(new Uint8Array(event.data.input));
      const telemetry = tokenizer.threadTelemetry();
      response(id, { ids, telemetry }, [ids.buffer, telemetry.buffer]);
      return;
    }
    if (operation === "close") {
      tokenizer?.free();
      tokenizer = undefined;
      response(id, null);
      return;
    }
    throw new Error(`unknown shared-controller operation ${operation}`);
  } catch (error) {
    failure(id, error);
  }
});
