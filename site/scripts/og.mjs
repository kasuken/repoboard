// Renders public/og.png (1200x630), the social preview card. Run with: node scripts/og.mjs
import sharp from 'sharp';
import { fileURLToPath } from 'node:url';

const W = 1200, H = 630, cell = 26, gap = 5, step = cell + gap;
const colours = { clean: '#55a463', changes: '#e2c08d', conflict: '#e4676b', behind: '#e0a526', ahead: '#3794ff' };
let seed = 20261119;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const pick = () => {
  const r = rand();
  return r < 0.58 ? 'clean' : r < 0.76 ? 'changes' : r < 0.785 ? 'conflict' : r < 0.89 ? 'behind' : r < 0.97 ? 'ahead' : 'gone';
};

let rects = '';
for (let y = 5; y < H; y += step) {
  for (let x = 5; x < W; x += step) {
    const s = pick();
    rects += s === 'gone'
      ? `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="2" fill="url(#hatch)" stroke="#e4676b" stroke-opacity=".6"/>`
      : `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="2" fill="${colours[s]}"/>`;
  }
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <defs><pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
    <rect width="3" height="6" fill="#e4676b"/></pattern></defs>
  <rect width="${W}" height="${H}" fill="#17131f"/>
  ${rects}
  <rect x="${5 + step * 2 - 6}" y="${5 + step * 4 - 6}" width="${step * 31 + 7}" height="${step * 13 + 7}" rx="12" fill="#17131f"/>
  <g font-family="Segoe UI Black, Arial Black, sans-serif" font-weight="900" fill="#f3eff8">
    <text x="104" y="232" font-size="76" letter-spacing="-1.5">Every git repo</text>
    <text x="104" y="316" font-size="76" letter-spacing="-1.5">on your machine,</text>
    <text x="104" y="400" font-size="76" letter-spacing="-1.5">on one board.</text>
  </g>
  <text x="106" y="476" font-family="Segoe UI, Arial, sans-serif" font-size="30" font-weight="600" fill="#b1a8c0">Repo Board, free for Windows, macOS, Linux and VS Code</text>
</svg>`;

const out = fileURLToPath(new URL('../public/og.png', import.meta.url));
await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toFile(out);
console.log('wrote', out);
