import { fromBytes } from "hypertok";

export const runtime = "edge";

const probeText = "vercel edge round trip \u{1F469}\u{1F3FD}\u200D\u{1F4BB}";

export async function GET(request) {
  try {
    const vocabularyResponse = await fetch(new URL("/vocab.htk", request.url));
    if (!vocabularyResponse.ok) {
      throw new Error(`vocabulary request failed with status ${vocabularyResponse.status}`);
    }
    const vocabulary = new Uint8Array(await vocabularyResponse.arrayBuffer());
    const tokenizer = await fromBytes(vocabulary);
    try {
      const ids = await tokenizer.encode(probeText);
      const decoded = tokenizer.decode(ids);
      return Response.json({
        ok: decoded === probeText,
        tier: tokenizer.tier,
        ids: [...ids],
        decoded,
      }, { status: decoded === probeText ? 200 : 500 });
    } finally {
      tokenizer.free();
    }
  } catch (error) {
    return Response.json({
      ok: false,
      name: error?.name,
      message: error?.message,
    }, { status: 500 });
  }
}
