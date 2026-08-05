import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { browserOutputDirectory, referenceSlugs } from "./build.mjs";
import { benchmarkTokenizerPath, readBenchmarkTokenizer } from "../common/gpt2_model.mjs";

const benchesDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
readBenchmarkTokenizer();

const routes = new Map([
  ["/bundle.mjs", [path.join(browserOutputDirectory, "bundle.mjs"), "text/javascript; charset=utf-8"]],
  [
    "/wasm/single/hypertok_wasm_core.js",
    [
      path.join(browserOutputDirectory, "wasm", "single", "hypertok_wasm_core.js"),
      "text/javascript; charset=utf-8",
    ],
  ],
  [
    "/wasm/single/hypertok_wasm_core_bg.wasm",
    [
      path.join(browserOutputDirectory, "wasm", "single", "hypertok_wasm_core_bg.wasm"),
      "application/wasm",
    ],
  ],
  [
    "/assets/tokenizer.json",
    [benchmarkTokenizerPath, "application/json"],
  ],
  [
    "/assets/gpt2.htk",
    [path.join(browserOutputDirectory, "gpt2.htk"), "application/octet-stream"],
  ],
  [
    "/assets/o200k.htk",
    [path.join(browserOutputDirectory, "o200k.htk"), "application/octet-stream"],
  ],
  [
    "/assets/kitoken-full.wasm",
    [path.join(benchesDirectory, "node_modules", "kitoken", "dist", "full_bg.wasm"), "application/wasm"],
  ],
  [
    "/assets/dqbd-lite.wasm",
    [
      path.join(
        benchesDirectory,
        "node_modules",
        "@dqbd",
        "tiktoken",
        "lite",
        "tiktoken_bg.wasm",
      ),
      "application/wasm",
    ],
  ],
  [
    "/assets/golia.wasm",
    [
      path.join(
        benchesDirectory,
        "node_modules",
        "@goliapkg",
        "tiktoken-wasm",
        "tiktoken_wasm_bg.wasm",
      ),
      "application/wasm",
    ],
  ],
  [
    "/corpus/manifest.json",
    [path.join(benchesDirectory, "corpus", "manifest.json"), "application/json"],
  ],
]);

for (const name of [
  "english-prose.txt",
  "chinese.txt",
  "source-code.txt",
  "emoji-heavy.txt",
  "long-document.txt",
  "standard-text.txt",
]) {
  routes.set(`/corpus/${name}`, [path.join(benchesDirectory, "corpus", name), "text/plain; charset=utf-8"]);
}
routes.set(
  "/corpus/openwebtext-slice.txt.gz",
  [
    path.join(benchesDirectory, "corpus", "openwebtext-slice.txt.gz"),
    "text/plain; charset=utf-8",
    "gzip",
  ],
);

for (const slug of referenceSlugs) {
  routes.set(
    `/references/${slug}.mjs`,
    [path.join(browserOutputDirectory, "references", `${slug}.mjs`), "text/javascript; charset=utf-8"],
  );
  routes.set(
    `/payloads/${slug}.mjs.gz`,
    [path.join(browserOutputDirectory, "references", `${slug}.mjs.gz`), "application/gzip"],
  );
}

const page = Buffer.from(`<!doctype html>
<meta charset="utf-8">
<title>hypertok harness</title>
<script type="module">
  globalThis.harnessReady = import("/bundle.mjs").then((module) => {
    globalThis.harness = module;
    return true;
  });
</script>
`);

function headers(contentType, contentEncoding) {
  const values = {
    "Content-Type": contentType,
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Cache-Control": "no-store",
  };
  if (contentEncoding !== undefined) values["Content-Encoding"] = contentEncoding;
  return values;
}

export async function startHarnessServer({
  pageContent = page,
  additionalRoutes = new Map(),
} = {}) {
  const activeRoutes = new Map(routes);
  const reservedRoutes = new Set(["/", "/blank"]);
  for (const [route, value] of additionalRoutes) {
    if (
      typeof route !== "string" ||
      !route.startsWith("/") ||
      reservedRoutes.has(route) ||
      activeRoutes.has(route)
    ) {
      throw new Error(`Invalid or duplicate harness route: ${route}`);
    }
    if (
      !Array.isArray(value) ||
      (value.length !== 2 && value.length !== 3) ||
      typeof value[0] !== "string" ||
      typeof value[1] !== "string" ||
      (value[2] !== undefined && typeof value[2] !== "string") ||
      !fs.existsSync(value[0]) ||
      !fs.statSync(value[0]).isFile()
    ) {
      throw new Error(`Invalid harness route target: ${route}`);
    }
    activeRoutes.set(route, value);
  }
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname === "/") {
      response.writeHead(200, headers("text/html; charset=utf-8"));
      response.end(pageContent);
      return;
    }
    if (url.pathname === "/blank") {
      response.writeHead(200, headers("text/html; charset=utf-8"));
      response.end("<!doctype html><meta charset=\"utf-8\"><title>hypertok measurement</title>");
      return;
    }
    const route = activeRoutes.get(url.pathname);
    if (route === undefined) {
      response.writeHead(404, headers("text/plain; charset=utf-8"));
      response.end("not found\n");
      return;
    }
    const [filePath, contentType, contentEncoding] = route;
    response.writeHead(200, headers(contentType, contentEncoding));
    fs.createReadStream(filePath).pipe(response);
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (typeof address === "string" || address === null) {
    throw new Error("Harness server did not bind a TCP port");
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    },
  };
}
