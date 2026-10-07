// Windows-1255 (Hebrew) codec. SKN files are written in this code page,
// one byte per character, which is what makes their fixed-width columns work.

const decoder = new TextDecoder("windows-1255");

const BYTE_TO_CHAR = decoder.decode(Uint8Array.from({ length: 256 }, (_, i) => i));
if (BYTE_TO_CHAR.length !== 256) throw new Error("windows-1255 table is not one char per byte");

const CHAR_TO_BYTE = new Map();
for (let i = 0; i < 256; i++) {
  const ch = BYTE_TO_CHAR[i];
  if (ch !== "�" && !CHAR_TO_BYTE.has(ch)) CHAR_TO_BYTE.set(ch, i);
}

export class SknEncodingError extends Error {
  constructor(char, index) {
    super(`Character "${char}" (U+${char.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}) at position ${index} cannot be written in an SKN file (windows-1255)`);
    this.name = "SknEncodingError";
    this.char = char;
    this.index = index;
  }
}

/** @param {Uint8Array} bytes */
export function decode1255(bytes) {
  return decoder.decode(bytes);
}

/** True when every character of `text` has a windows-1255 byte. */
export function canEncode1255(text) {
  for (const ch of text) if (!CHAR_TO_BYTE.has(ch)) return false;
  return true;
}

/** @param {string} text @returns {Uint8Array} */
export function encode1255(text) {
  const out = new Uint8Array(text.length);
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const byte = CHAR_TO_BYTE.get(text[i]);
    if (byte === undefined) throw new SknEncodingError(String.fromCodePoint(text.codePointAt(i)), i);
    out[n++] = byte;
  }
  return out.subarray(0, n);
}
