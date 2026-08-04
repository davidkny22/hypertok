const unavailableMessage = "measureUserAgentSpecificMemory is not available";

function finiteBytes(label, value) {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative finite byte count`);
  }
  return value;
}

export function cdpResidentBytes(usage) {
  return (
    finiteBytes("usedSize", usage.usedSize) +
    finiteBytes("embedderHeapUsedSize", usage.embedderHeapUsedSize ?? 0) +
    finiteBytes("backingStorageSize", usage.backingStorageSize ?? 0)
  );
}

export async function measureBrowserMemory(page) {
  await page.evaluate(() => globalThis.gc?.());
  try {
    const measurement = await page.evaluate(() =>
      performance.measureUserAgentSpecificMemory(),
    );
    return Object.freeze({
      bytes: finiteBytes("user agent memory", measurement.bytes),
      method: "measureUserAgentSpecificMemory",
      details: measurement,
    });
  } catch (error) {
    if (!String(error?.message).includes(unavailableMessage)) throw error;
  }

  const session = await page.context().newCDPSession(page);
  try {
    await session.send("HeapProfiler.collectGarbage");
    const usage = await session.send("Runtime.getHeapUsage");
    return Object.freeze({
      bytes: cdpResidentBytes(usage),
      method: "cdp-runtime-heap-usage",
      details: usage,
    });
  } finally {
    await session.detach();
  }
}
