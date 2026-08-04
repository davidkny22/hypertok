import { fromBytes } from "./runtime/index.mjs";
import { tokenSegments } from "./span-map.mjs";

const VOCABS = Object.freeze([
  Object.freeze({ name: "gpt-2", file: "gpt2.htk" }),
  Object.freeze({ name: "o200k", file: "o200k_base.htk" }),
  Object.freeze({ name: "qwen3.6", file: "qwen3.6.htk" }),
  Object.freeze({ name: "tekken", file: "mistral-tekken.htk" }),
  Object.freeze({ name: "deepseek-v4", file: "deepseek-v4.htk" }),
  Object.freeze({ name: "kimi-k3", file: "kimi-k3.htk" }),
]);

const SAMPLES = Object.freeze({
  english: [
    "The receipt records the load: the vocabulary arrived and became ready in the time shown. The editor measures encoding as you type.",
    "Language models never see letters. They see tokens: short byte sequences learned from data, frequent words as single units, rare words assembled from pieces. Every prompt you have ever sent was first cut into these pieces, counted against a context window, and billed by the piece.",
    "Token counting is invisible plumbing. Chat interfaces count before sending, gateways count for rate limits and billing, retrieval pipelines cut documents into token-sized chunks, and editors show live counts as you write. Each count sits on a path where latency matters.",
    "Your browser measures the text you bring as you type. The numbers come from your machine, not a stored benchmark table.",
  ].join("\n\n"),
  chinese: [
    "四海之内皆兄弟。学而时习之，不亦说乎？有朋自远方来，不亦乐乎？温故而知新，可以为师矣。三人行，必有我师焉。",
    "北冥有鱼，其名为鲲。鲲之大，不知其几千里也；化而为鸟，其名为鹏。鹏之背，不知其几千里也；怒而飞，其翼若垂天之云。是鸟也，海运则将徙于南冥。南冥者，天池也。",
    "大学之道，在明明德，在亲民，在止于至善。知止而后有定，定而后能静，静而后能安，安而后能虑，虑而后能得。物有本末，事有终始，知所先后，则近道矣。",
    "天地玄黄，宇宙洪荒。日月盈昃，辰宿列张。寒来暑往，秋收冬藏。闰余成岁，律吕调阳。云腾致雨，露结为霜。金生丽水，玉出昆冈。剑号巨阙，珠称夜光。果珍李柰，菜重芥姜。",
    "中文分词对分词器是一场难度更高的考试：没有空格作为边界，每个汉字占三个字节，词表覆盖参差不齐。这段文字存在的意义，就是让你亲眼看看它在这样的输入上跑得怎么样。",
  ].join("\n"),
  code: [
    "fn encode(text: &str) -> Vec<u32> {",
    "    let pieces = pretokenize(text);",
    "    pieces.flat_map(|piece| merge(piece)).collect()",
    "}",
    "",
    "fn merge(piece: &[u8]) -> impl Iterator<Item = u32> {",
    "    let mut symbols: Vec<Symbol> = piece.iter().map(Symbol::from_byte).collect();",
    "    loop {",
    "        let Some((rank, index)) = best_pair(&symbols) else { break };",
    "        symbols[index] = symbols[index].fuse(&symbols[index + 1], rank);",
    "        symbols.remove(index + 1);",
    "    }",
    "    symbols.into_iter().map(|symbol| symbol.id)",
    "}",
    "",
    "const routes = new Map([",
    "  [\"/encode\", async (request) => json(await tokenizer.encode(await request.text()))],",
    "  [\"/decode\", async (request) => text(tokenizer.decode(await request.json()))],",
    "  [\"/count\", async (request) => json({ tokens: (await tokenizer.encode(await request.text())).length })],",
    "]);",
    "",
    "export async function handle(request) {",
    "  const route = routes.get(new URL(request.url).pathname);",
    "  if (!route) return new Response(\"not found\", { status: 404 });",
    "  return route(request);",
    "}",
    "",
    "// Tokenizers handle code like this: dense punctuation,",
    "// identifiers that fuse words, indentation that is all bytes and no prose.",
  ].join("\n"),
  emoji: [
    "🚀 tokenizers handle more than words: 👩‍👩‍👧‍👧 families, flags 🇯🇵🇧🇷🇰🇪, skin tones 👍🏽✋🏿, and the odd 🦕.",
    "One visible emoji can span several code points. Families use joiners, and flags use two regional indicators. Tone modifiers ride a base. Each one enters the byte stream and must return intact.",
    "🧪 the stress test: 🌊🌊🌊 water everywhere 🌊🌊🌊, a 🐕‍🦺 service dog, a 🏳️‍🌈 flag, a 🧑🏾‍🚀 astronaut, and the classic mixed line where prose meets symbols: meeting at 3pm ☕ then 🏃‍♀️💨 to catch the 🚂.",
    "字符集混排也是日常：中文、emoji 🎌、English, and numbers 12345 all in one line, exactly the shape real chat traffic has.",
  ].join("\n\n"),
});

const byId = (id) => document.getElementById(id);
const input = byId("input");
const paint = byId("paint");
const status = byId("status");
const receipt = byId("receipt");
const chip = byId("chip");
const race = byId("race");

/* The rivals cover a common JavaScript port, a fast specialist, a WebAssembly
   port, and the reference implementation. Each races only supported vocabularies. */
const HF_FAMILIES = Object.freeze(["qwen3.6", "tekken", "deepseek-v4", "gpt-2"]);
const RIVALS = Object.freeze([
  Object.freeze({
    name: "js-tiktoken",
    supports: (vocab) => vocab === "o200k" || vocab === "gpt-2",
    unsupported: (vocab) => `does not support ${vocab}`,
    load: async (vocab) => {
      const mod = await import(vocab === "gpt-2"
        ? "./incumbents/js-tiktoken-gpt2.mjs"
        : "./incumbents/js-tiktoken-o200k.mjs");
      return (text) => mod.encode(text);
    },
  }),
  Object.freeze({
    name: "gpt-tokenizer",
    supports: (vocab) => vocab === "o200k" || vocab === "gpt-2",
    unsupported: (vocab) => `does not support ${vocab}`,
    load: async (vocab) => {
      const mod = await import(vocab === "gpt-2"
        ? "./incumbents/gpt-tokenizer-gpt2.mjs"
        : "./incumbents/gpt-tokenizer-o200k.mjs");
      return (text) => mod.encode(text);
    },
  }),
  Object.freeze({
    name: "@dqbd/tiktoken",
    supports: (vocab) => vocab === "o200k" || vocab === "gpt-2",
    unsupported: (vocab) => `does not support ${vocab}`,
    load: async (vocab) => {
      const mod = await import(vocab === "gpt-2"
        ? "./incumbents/dqbd-tiktoken-gpt2.mjs"
        : "./incumbents/dqbd-tiktoken-o200k.mjs");
      await mod.ready(new URL("./incumbents/dqbd-tiktoken_bg.wasm", import.meta.url).href);
      return (text) => mod.encode(text);
    },
  }),
  Object.freeze({
    name: "hf tokenizers",
    supports: (vocab) => HF_FAMILIES.includes(vocab),
    unsupported: (vocab) => vocab === "kimi-k3"
      ? "kimi k3 publishes no tokenizer.json"
      : "no official o200k tokenizer.json",
    load: async (vocab) => {
      const mod = await import("./incumbents/hf-tokenizers.mjs");
      const [tokenizerJson, tokenizerConfig] = await Promise.all([
        fetch(new URL(`./incumbents/data/${vocab}.tokenizer.json`, import.meta.url)).then((r) => r.json()),
        fetch(new URL(`./incumbents/data/${vocab}.tokenizer_config.json`, import.meta.url)).then((r) => r.json()),
      ]);
      return mod.makeEncoder(tokenizerJson, tokenizerConfig);
    },
  }),
]);
const incumbentCache = new Map();
let raceTimer = 0;
let raceGeneration = 0;
const encoder = new TextEncoder();
let vocabIndex = 0;
let tokenizer;
let bootGeneration = 0;
let renderGeneration = 0;

function formatBytes(bytes) {
  return `${(bytes / 1_000_000).toFixed(2)} MB`;
}

function formatTime(elapsedMs) {
  if (elapsedMs < 1) return `${(elapsedMs * 1000).toFixed(0)} µs`;
  if (elapsedMs < 100) return `${elapsedMs.toFixed(1)} ms`;
  return `${elapsedMs.toFixed(0)} ms`;
}

function formatSpeed(mbPerSecond) {
  if (mbPerSecond >= 1) return `${mbPerSecond.toFixed(1)} MB/s`;
  return `${(mbPerSecond * 1000).toFixed(0)} KB/s`;
}

function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/* Chrome without cross-origin isolation quantizes performance.now() to 100
   microseconds. A 1 percent target error requires 10 ms windows (0.1 / 0.01).
   A call at or above 250 ms stands alone with 0.04 percent timer error. Four
   windows run round-robin, the first is discarded, and the median of the rest
   supplies the time. Noise is (max - min) / median. A verdict requires a gap
   greater than twice the combined noise. */
const CLOCK_QUANTUM_MS = 0.1;
const TARGET_RELATIVE_ERROR = 0.01;
const WINDOW_MS = CLOCK_QUANTUM_MS / TARGET_RELATIVE_ERROR;
const LONG_CALL_MS = 250;
/* Four windows per lane, with the first discarded as JIT ramp. */
const ROUNDS = 4;
const NOISE_SAFETY = 2;

async function timedWindow(lane) {
  let iterations = lane.iterations ?? 1;
  for (;;) {
    const started = performance.now();
    for (let index = 0; index < iterations; index += 1) await lane.run();
    const elapsed = performance.now() - started;
    if (elapsed >= WINDOW_MS || (iterations === 1 && elapsed >= LONG_CALL_MS)) {
      lane.iterations = iterations;
      if (iterations === 1 && elapsed >= LONG_CALL_MS) lane.done = true;
      return Math.max(elapsed / iterations, 0.0001);
    }
    iterations = Math.max(
      iterations * 2,
      Math.ceil((iterations * WINDOW_MS * 1.2) / Math.max(elapsed, CLOCK_QUANTUM_MS)),
    );
  }
}

function laneStats(lane) {
  const usable = lane.windows.length > 1 ? lane.windows.slice(1) : lane.windows;
  const sorted = usable.slice().sort((a, b) => a - b);
  const ms = sorted[Math.floor(sorted.length / 2)];
  const noise = sorted.length > 1 ? (sorted[sorted.length - 1] - sorted[0]) / ms : 0.01;
  return { ms, noise };
}

function sameIds(ours, theirs) {
  if (!ours || !theirs || ours.length !== theirs.length) return false;
  for (let index = 0; index < ours.length; index += 1) {
    if (ours[index] !== theirs[index]) return false;
  }
  return true;
}

async function runRace() {
  const generation = ++raceGeneration;
  const active = tokenizer;
  const text = currentText();
  if (!active || !text) {
    race.textContent = "";
    return;
  }
  const vocab = VOCABS[vocabIndex];
  race.textContent = "racing";
  const bytes = encoder.encode(text).length;
  const ourLane = {
    name: "hypertok",
    windows: [],
    run: async () => { ourLane.last = active.encodeSync(text); },
  };
  const lanes = [ourLane];
  const failed = [];
  for (const rival of RIVALS) {
    if (!rival.supports(vocab.name)) {
      failed.push({ name: rival.name, reason: rival.unsupported(vocab.name) });
      continue;
    }
    const cacheKey = `${rival.name}:${vocab.name}`;
    let encodeFn = incumbentCache.get(cacheKey);
    if (!encodeFn) {
      race.textContent = `fetching ${rival.name}`;
      try {
        encodeFn = await rival.load(vocab.name);
        incumbentCache.set(cacheKey, encodeFn);
      } catch {
        failed.push({ name: rival.name, reason: "unavailable" });
        continue;
      }
      if (generation !== raceGeneration || active !== tokenizer) return;
    }
    const lane = {
      name: rival.name,
      windows: [],
      run: async () => { lane.last = encodeFn(text); },
    };
    lanes.push(lane);
  }
  race.textContent = "racing";
  if (generation !== raceGeneration || active !== tokenizer) return;
  try {
    for (const lane of lanes) {
      const started = performance.now();
      await lane.run();
      const warm = performance.now() - started;
      if (warm >= LONG_CALL_MS) {
        lane.windows.push(warm);
        lane.done = true;
      }
    }
    for (let round = 0; round < ROUNDS; round += 1) {
      for (const lane of lanes) {
        if (lane.done && lane.windows.length) continue;
        lane.windows.push(await timedWindow(lane));
        if (generation !== raceGeneration || active !== tokenizer) return;
      }
    }
  } catch (error) {
    race.textContent = `race failed: ${error instanceof Error ? error.message : error}`;
    return;
  }
  if (generation !== raceGeneration || active !== tokenizer) return;
  const our = laneStats(ourLane);
  const speedOf = (ms) => bytes / (ms / 1000) / 1_000_000;
  const rivalsTimed = [];
  for (const lane of lanes.slice(1)) {
    const stats = laneStats(lane);
    const significant = Math.abs(stats.ms / our.ms - 1) > NOISE_SAFETY * (our.noise + stats.noise);
    rivalsTimed.push({ name: lane.name, ...stats, significant, identical: sameIds(ourLane.last, lane.last) });
  }
  /* The fastest lane spans the full track. Each other bar shows its fraction
     of that speed, with the measured time and throughput beside it. */
  const fastestMs = Math.min(our.ms, ...rivalsTimed.map((lane) => lane.ms));
  const laneRow = (cls, name, stats, label) => {
    const row = document.createElement("div");
    row.className = `lane ${cls}`;
    const head = document.createElement("div");
    head.className = "lane-head";
    const laneName = document.createElement("span");
    laneName.className = "lane-name";
    laneName.textContent = name;
    const nums = document.createElement("span");
    nums.className = "lane-nums";
    nums.replaceChildren(
      metric(formatTime(stats.ms)),
      separator(),
      metric(formatSpeed(speedOf(stats.ms))),
      ...(label ? [separator(), label] : []),
    );
    head.append(laneName, nums);
    const track = document.createElement("div");
    track.className = "lane-track";
    const fill = document.createElement("div");
    fill.className = "lane-fill";
    fill.style.setProperty("--w", (fastestMs / stats.ms).toFixed(4));
    track.append(fill);
    row.append(head, track);
    return row;
  };
  const laneRows = [laneRow("us", "hypertok", our, "")];
  for (const lane of rivalsTimed) {
    const ratio = lane.ms / our.ms;
    const label = !lane.significant
      ? "within noise"
      : ratio >= 1
        ? `${ratio.toFixed(1)}x slower`
        : `${(1 / ratio).toFixed(1)}x faster`;
    laneRows.push(laneRow("them", lane.name, lane, label));
  }
  for (const miss of failed) {
    const row = document.createElement("div");
    row.className = "lane them";
    const head = document.createElement("div");
    head.className = "lane-head";
    const laneName = document.createElement("span");
    laneName.className = "lane-name";
    laneName.textContent = miss.name;
    const nums = document.createElement("span");
    nums.className = "lane-nums";
    nums.textContent = miss.reason;
    head.append(laneName, nums);
    row.append(head);
    laneRows.push(row);
  }
  const verdict = document.createElement("div");
  verdict.className = "verdict";
  if (rivalsTimed.length) {
    const allMatch = rivalsTimed.every((lane) => lane.identical);
    const matchLine = document.createElement("div");
    matchLine.className = "match";
    matchLine.textContent = allMatch
      ? `outputs match: ${ourLane.last.length.toLocaleString()} tokens identical`
      : "outputs differ";
    const fastest = rivalsTimed.reduce((a, b) => (a.ms < b.ms ? a : b));
    if (!fastest.significant) {
      const line = document.createElement("div");
      line.className = "match";
      line.textContent = "the gap appears with longer text";
      verdict.append(line, matchLine);
    } else {
      const mult = document.createElement("div");
      mult.className = "mult";
      const sub = document.createElement("div");
      sub.className = "mult-sub";
      if (fastest.ms >= our.ms) {
        mult.textContent = `${(fastest.ms / our.ms).toFixed(1)}x`;
        sub.textContent = `faster than ${fastest.name}`;
      } else {
        mult.style.color = "var(--them)";
        mult.textContent = `${(our.ms / fastest.ms).toFixed(1)}x`;
        sub.textContent = `${fastest.name} is faster here`;
      }
      verdict.append(mult, sub, matchLine);
    }
  }
  race.replaceChildren(...laneRows, verdict);
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      race.querySelectorAll(".lane-fill").forEach((fill) => fill.classList.add("run"));
    });
  });
}

function currentText() {
  return input.innerText.replace(/\r\n/g, "\n").replace(/\n$/, "");
}

function setReceiptLoading(vocab) {
  receipt.setAttribute("aria-busy", "true");
  receipt.replaceChildren();
  const button = document.createElement("button");
  button.className = "vocab";
  button.disabled = true;
  button.textContent = vocab.name;
  receipt.append(button, separator(), "fetching");
}

function separator() {
  const span = document.createElement("span");
  span.className = "sep";
  span.innerHTML = "&middot;";
  return span;
}

function metric(value) {
  const element = document.createElement("b");
  element.textContent = value;
  return element;
}

function setReceiptReady(vocab, byteLength, elapsedMs) {
  receipt.setAttribute("aria-busy", "false");
  receipt.replaceChildren();
  const button = document.createElement("button");
  button.className = "vocab";
  button.id = "switch";
  button.title = "switch vocabulary";
  button.textContent = vocab.name;
  button.addEventListener("click", () => {
    vocabIndex = (vocabIndex + 1) % VOCABS.length;
    void boot();
  });
  const ready = metric(formatTime(elapsedMs));
  ready.className = "ready";
  receipt.append(
    button,
    separator(),
    metric(formatBytes(byteLength)),
    " fetched",
    separator(),
    "ready in ",
    ready,
  );
}

function showError(error) {
  status.textContent = error instanceof Error ? error.message : String(error);
}

const PAINT_LIMIT = 2000;

function paintTokens(text, ids, starts) {
  const { leading, segments } = tokenSegments(text, ids, starts);
  paint.replaceChildren();
  if (leading) paint.append(document.createTextNode(leading));
  let paintedChars = leading.length;
  const painted = segments.slice(0, PAINT_LIMIT);
  painted.forEach((segment, index) => {
    const span = document.createElement("span");
    span.className = `t${index % 5}`;
    span.textContent = segment.text;
    span.dataset.id = segment.ids.join(", ");
    paint.append(span);
    paintedChars += segment.text.length;
  });
  if (segments.length > PAINT_LIMIT) {
    paint.append(document.createTextNode(text.slice(paintedChars)));
  }
}

async function render() {
  const generation = ++renderGeneration;
  const active = tokenizer;
  const text = currentText();
  if (!active || !text) {
    paint.replaceChildren();
    status.textContent = "";
    race.textContent = "";
    clearTimeout(raceTimer);
    return;
  }
  try {
    const started = performance.now();
    const detail = await active.encodeDetailed(text);
    const elapsedMs = performance.now() - started;
    if (generation !== renderGeneration || active !== tokenizer) return;
    paintTokens(text, detail.ids, detail.starts);
    status.replaceChildren(
      metric(detail.ids.length.toLocaleString()),
      " tokens",
    );
    clearTimeout(raceTimer);
    raceTimer = setTimeout(() => void runRace(), 500);
  } catch (error) {
    if (generation === renderGeneration) showError(error);
  }
}

async function boot() {
  const generation = ++bootGeneration;
  const vocab = VOCABS[vocabIndex];
  renderGeneration += 1;
  raceGeneration += 1;
  clearTimeout(raceTimer);
  setReceiptLoading(vocab);
  status.textContent = "";
  race.textContent = "";
  const started = performance.now();
  try {
    const response = await fetch(new URL(`./vocab/${vocab.file}`, import.meta.url));
    if (!response.ok) throw new Error(`vocabulary fetch failed with HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const next = await fromBytes(bytes, { tier: "single" });
    if (generation !== bootGeneration) {
      next.free();
      return;
    }
    const previous = tokenizer;
    tokenizer = next;
    previous?.free();
    setReceiptReady(vocab, bytes.byteLength, performance.now() - started);
    // Populate lazy tokenizer state before any user-visible latency or race measurement.
    await next.encodeDetailed("warm the engine before the first visible measurement");
    await render();
  } catch (error) {
    if (generation !== bootGeneration) return;
    receipt.setAttribute("aria-busy", "false");
    receipt.textContent = `${vocab.name} · unavailable`;
    showError(error);
  }
}

input.addEventListener("input", () => void render());
input.addEventListener("paste", (event) => {
  event.preventDefault();
  document.execCommand("insertText", false, event.clipboardData.getData("text/plain"));
});

document.querySelectorAll(".samples button").forEach((button) => {
  button.addEventListener("click", () => {
    input.textContent = SAMPLES[button.dataset.s];
    void render();
    input.focus();
  });
});

document.querySelector(".editor").addEventListener("mousemove", (event) => {
  input.style.pointerEvents = "none";
  const element = document.elementFromPoint(event.clientX, event.clientY);
  input.style.pointerEvents = "";
  if (element?.dataset?.id) {
    chip.style.display = "block";
    chip.style.left = `${event.clientX + 12}px`;
    chip.style.top = `${event.clientY + 14}px`;
    chip.textContent = `${element.dataset.id.includes(",") ? "ids" : "id"} ${element.dataset.id}`;
  } else {
    chip.style.display = "none";
  }
});
document.querySelector(".editor").addEventListener("mouseleave", () => {
  chip.style.display = "none";
});
globalThis.addEventListener("pagehide", () => tokenizer?.free(), { once: true });

void boot();
