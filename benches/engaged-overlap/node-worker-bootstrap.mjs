import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parentPort, workerData, Worker as NodeWorker } from "node:worker_threads";

globalThis.self = globalThis;
const listeners = new Map();
globalThis.postMessage = (value, transfer = []) => parentPort.postMessage(value, transfer);
globalThis.addEventListener = (type, listener) => {
  const current = listeners.get(type) ?? [];
  current.push(listener);
  listeners.set(type, current);
};
globalThis.removeEventListener = (type, listener) => {
  const current = listeners.get(type) ?? [];
  listeners.set(type, current.filter((candidate) => candidate !== listener));
};
parentPort.on("message", (data) => {
  for (const listener of listeners.get("message") ?? []) listener({ data });
});

globalThis.Worker = class NestedBrowserWorker {
  constructor(target, options = {}) {
    this.inner = new NodeWorker(new URL(import.meta.url), {
      type: "module",
      workerData: { target: String(target), options },
    });
    this.listeners = new Map();
    this.inner.on("message", (data) => this.dispatch("message", { data }));
    this.inner.on("error", (error) => this.dispatch("error", error));
  }

  addEventListener(type, listener) {
    const current = this.listeners.get(type) ?? [];
    current.push(listener);
    this.listeners.set(type, current);
  }

  removeEventListener(type, listener) {
    const current = this.listeners.get(type) ?? [];
    this.listeners.set(type, current.filter((candidate) => candidate !== listener));
  }

  dispatch(type, event) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  postMessage(value, transfer = []) {
    this.inner.postMessage(value, transfer);
  }

  terminate() {
    return this.inner.terminate();
  }
};

const nativeFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (!url.startsWith("file:")) return nativeFetch(input, init);
  const body = await readFile(fileURLToPath(url));
  return new Response(body, { headers: { "content-type": "application/wasm" } });
};

await import(workerData.target);
