/** Fail-closed JPEG sanitization for publication: pure, no file or network access. */
export interface SanitizedJpeg { bytes: Uint8Array; width: number; height: number; }

const startsWith = (data: Uint8Array, from: number, text: string): boolean =>
  [...text].every((c, i) => data[from + i] === c.charCodeAt(0));

/**
 * Keep only what decodes the primary image: JFIF APP0, ICC APP2, tables and one
 * baseline scan. Exif (including GPS), XMP, MPF, gain maps, comments and every
 * byte after the first EOI are dropped. Anything unrecognized refuses (null)
 * rather than being copied, so no unknown segment can carry metadata through.
 */
export function sanitizeJpeg(input: Uint8Array): SanitizedJpeg | null {
  if (input.length < 4 || input[0] !== 0xff || input[1] !== 0xd8) return null;
  const kept: Uint8Array[] = [input.subarray(0, 2)];
  let i = 2, width = 0, height = 0, frames = 0;
  while (i + 4 <= input.length) {
    if (input[i] !== 0xff) return null;
    const marker = input[i + 1];
    const length = (input[i + 2] << 8) | input[i + 3];
    if (length < 2 || i + 2 + length > input.length) return null;
    const segment = input.subarray(i, i + 2 + length), data = i + 4;
    if (marker === 0xe0) { if (startsWith(input, data, 'JFIF\0')) kept.push(segment); }
    else if (marker === 0xe2) { if (startsWith(input, data, 'ICC_PROFILE\0')) kept.push(segment); }
    else if ((marker >= 0xe1 && marker <= 0xef) || marker === 0xfe) { /* metadata: dropped */ }
    else if (marker === 0xdb || marker === 0xc4 || marker === 0xdd) kept.push(segment);
    else if (marker === 0xc0 || marker === 0xc1) {
      if (++frames > 1 || length < 8) return null;
      height = (input[data + 1] << 8) | input[data + 2];
      width = (input[data + 3] << 8) | input[data + 4];
      kept.push(segment);
    } else if (marker === 0xda) {
      if (frames !== 1 || !width || !height) return null;
      // Entropy-coded data may contain only stuffed 0xFF00 and restart markers
      // before EOI. A further scan or table means a multi-scan image: refuse.
      let j = i + 2 + length;
      for (;;) {
        while (j < input.length && input[j] !== 0xff) j++;
        if (j + 1 >= input.length) return null;
        const next = input[j + 1];
        if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) { j += 2; continue; }
        if (next !== 0xd9) return null;
        break;
      }
      kept.push(input.subarray(i, j + 2));
      const bytes = new Uint8Array(kept.reduce((n, part) => n + part.length, 0));
      let offset = 0;
      for (const part of kept) { bytes.set(part, offset); offset += part.length; }
      return { bytes, width, height };
    } else return null; // Progressive/arithmetic/lossless frames, DNL and unknown markers.
    i += 2 + length;
  }
  return null;
}
