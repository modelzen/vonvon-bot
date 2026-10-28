// Run with Electron: node node_modules/electron/cli.js scripts/build-windows-icon.cjs
// Reuse the original artwork; only remove the padding intended for the macOS Dock.
const { app, nativeImage } = require('electron');
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { PNG } = require('pngjs');

app.whenReady().then(() => {
  const assets = join(__dirname, '../packages/desktop/assets');
  const input = join(assets, 'macos-icon.png');
  const png = PNG.sync.read(readFileSync(input));
  let left = png.width, top = png.height, right = -1, bottom = -1;
  for (let y = 0; y < png.height; y++) for (let x = 0; x < png.width; x++) {
    if (png.data[(y * png.width + x) * 4 + 3] <= 16) continue;
    left = Math.min(left, x); top = Math.min(top, y);
    right = Math.max(right, x); bottom = Math.max(bottom, y);
  }
  if (right < left || bottom < top) throw new Error('The source logo is empty');
  // Keep a small transparent border so the antialiased outer edge is not clipped.
  left = Math.max(0, left - 4); top = Math.max(0, top - 4);
  right = Math.min(png.width - 1, right + 4); bottom = Math.min(png.height - 1, bottom + 4);
  const image = nativeImage.createFromPath(input).crop({ x: left, y: top, width: right - left + 1, height: bottom - top + 1 });
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const frames = sizes.map(size => image.resize({ width: size, height: size, quality: 'best' }).toPNG());
  const header = Buffer.alloc(6 + sizes.length * 16);
  header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  frames.forEach((frame, index) => {
    const entry = 6 + index * 16;
    header[entry] = sizes[index] % 256; header[entry + 1] = sizes[index] % 256;
    header.writeUInt16LE(1, entry + 4); header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(frame.length, entry + 8); header.writeUInt32LE(offset, entry + 12);
    offset += frame.length;
  });
  writeFileSync(join(assets, 'windows-icon.ico'), Buffer.concat([header, ...frames]));
  if (process.argv[2]) writeFileSync(process.argv[2], image.resize({ width: 256, height: 256, quality: 'best' }).toPNG());
  console.log(`Windows logo: ${right - left + 1} x ${bottom - top + 1}; ICO sizes: ${sizes.join(', ')}`);
  app.exit(0);
}).catch(error => { console.error(error.message); app.exit(1); });
