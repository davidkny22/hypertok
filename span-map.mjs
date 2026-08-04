const encoder = new TextEncoder();

/* Token starts are UTF-8 byte offsets. Byte-level BPE may start inside a
   multibyte character, which cannot be painted in parts. Merge that token into
   the character's visual segment and retain every token id. */
export function tokenSegments(text, ids, starts) {
  if (!(ids instanceof Uint32Array) || !(starts instanceof Uint32Array)) {
    throw new TypeError("ids and starts must be Uint32Array values");
  }
  if (ids.length !== starts.length) {
    throw new Error("ids and starts must have equal lengths");
  }
  const bytePositions = [0];
  const charPositions = [0];
  let byteOffset = 0;
  let codeUnitOffset = 0;
  for (const scalar of text) {
    byteOffset += encoder.encode(scalar).length;
    codeUnitOffset += scalar.length;
    bytePositions.push(byteOffset);
    charPositions.push(codeUnitOffset);
  }
  const snap = (target) => {
    let low = 0;
    let high = bytePositions.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (bytePositions[mid] <= target) low = mid;
      else high = mid - 1;
    }
    return charPositions[low];
  };
  const firstChar = starts.length ? snap(starts[0]) : 0;
  const leading = text.slice(0, firstChar);
  const segments = [];
  let pending = [];
  for (let index = 0; index < ids.length; index += 1) {
    const startChar = snap(starts[index]);
    const endChar = index + 1 < ids.length ? snap(starts[index + 1]) : text.length;
    if (endChar > startChar) {
      segments.push({ ids: [...pending, ids[index]], text: text.slice(startChar, endChar) });
      pending = [];
    } else if (segments.length) {
      segments[segments.length - 1].ids.push(ids[index]);
    } else {
      pending.push(ids[index]);
    }
  }
  if (pending.length && segments.length) segments[0].ids.unshift(...pending);
  return Object.freeze({
    leading,
    segments: Object.freeze(segments.map((segment) => Object.freeze(segment))),
  });
}
