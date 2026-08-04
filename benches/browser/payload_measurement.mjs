export async function loadReferencePayload(page, origin, slug, vocabulary = "gpt2") {
  return page.evaluate(
    async ({ payloadUrl, moduleUrl, vocabularyId }) => {
      const transferStarted = performance.now();
      const response = await fetch(payloadUrl, { cache: "no-store" });
      if (!response.ok) throw new Error(`${payloadUrl}: HTTP ${response.status}`);
      const compressed = new Uint8Array(await response.arrayBuffer());
      const transferMilliseconds = performance.now() - transferStarted;

      const decompressionStarted = performance.now();
      const decompressed = new Uint8Array(
        await new Response(
          new Blob([compressed]).stream().pipeThrough(new DecompressionStream("gzip")),
        ).arrayBuffer(),
      );
      const decompressionMilliseconds = performance.now() - decompressionStarted;

      const materialisationStarted = performance.now();
      const module = await import(moduleUrl);
      const adapter = await module.createAdapter(vocabularyId);
      const probeIds = Array.from(adapter.encode("x"));
      const materialisationMilliseconds = performance.now() - materialisationStarted;

      globalThis.activeReference?.dispose();
      globalThis.activeReference = adapter;
      return {
        reference: adapter.id,
        vocabulary: adapter.vocabulary,
        version: adapter.version,
        compressedBytes: compressed.length,
        decompressedBytes: decompressed.length,
        transferMilliseconds,
        decompressionMilliseconds,
        materialisationMilliseconds,
        probeIds,
      };
    },
    {
      payloadUrl: `${origin}/payloads/${slug}.mjs.gz`,
      moduleUrl: `${origin}/references/${slug}.mjs?payload=${Date.now()}`,
      vocabularyId: vocabulary,
    },
  );
}

export async function disposeReferencePayload(page) {
  await page.evaluate(() => {
    globalThis.activeReference?.dispose();
    delete globalThis.activeReference;
  });
}
