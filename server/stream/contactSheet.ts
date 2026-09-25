import sharp from '../imageProcessing.js';

const TILE_WIDTH = 512;
const TILE_HEIGHT = 288;
const LABEL_HEIGHT = 28;

function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function labelSvg(text: string): Buffer {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${TILE_WIDTH}" height="${LABEL_HEIGHT}">` +
      `<rect width="${TILE_WIDTH}" height="${LABEL_HEIGHT}" fill="#10151d"/>` +
      `<text x="10" y="19" font-family="sans-serif" font-size="15" fill="#dbe4f0">${escapeXml(text)}</text>` +
      '</svg>',
  );
}

// Builds a horizontal time-ordered contact sheet: one row of frames, each
// labeled "F<n> <t>s". VLMs handle a single labeled grid more reliably than
// a list of separate images.
export async function buildContactSheet(
  inputs: { path: string; label: string }[],
): Promise<Buffer> {
  const tiles = await Promise.all(
    inputs.map(async (input, index) => {
      const frame = await sharp(input.path)
        .resize(TILE_WIDTH, TILE_HEIGHT, { fit: 'fill' })
        .composite([
          { input: labelSvg(input.label), top: 0, left: 0 },
        ])
        .jpeg({ quality: 85 })
        .toBuffer();
      return { input: frame, left: index * TILE_WIDTH, top: 0 };
    }),
  );
  return sharp({
    create: {
      width: TILE_WIDTH * inputs.length,
      height: TILE_HEIGHT,
      channels: 3,
      background: '#000000',
    },
  })
    .composite(tiles)
    .jpeg({ quality: 82 })
    .toBuffer();
}

export function contactSheetLabels(count: number, spacingSec: number): string[] {
  return Array.from(
    { length: count },
    (_, index) => `F${index + 1}  ${(index * spacingSec).toFixed(1)}s`,
  );
}
