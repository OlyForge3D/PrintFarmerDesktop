// Squirrel shows a single animated GIF for the whole silent install, and its
// bundled default is a pale-green spinner with no product name on it. This
// renders a branded replacement so the asset is reproducible and reviewable as
// code rather than an opaque binary someone dropped into `assets/`.
//
// Text is drawn with Canvas2D inside an offscreen Electron window rather than a
// hand-rolled bitmap font: Electron is already a required devDependency, so
// this adds no download, and real font rasterisation looks far better at this
// size. The trade-off is that output depends on the host's fonts, so regenerate
// on Windows to keep the committed GIF consistent.
//
// Run with: npx electron scripts/generate-installer-gif.mjs

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow } from 'electron';

const WIDTH = 268;
const HEIGHT = 167;
const FRAME_COUNT = 24;
const FRAME_DELAY_CENTISECONDS = 6;

const COLORS = {
  background: '#0e1116',
  inert: '#1b2029',
  accent: '#86c7f2',
  textPrimary: '#e6edf3',
  textMuted: '#8b949e',
};

/**
 * Runs inside the renderer. Returns one base64 RGB buffer per frame.
 *
 * Serialised with `toString()` and injected, so it must be self-contained and
 * must not close over anything in this module.
 */
function drawFrames(config) {
  const { width, height, frameCount, colors } = config;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');

  // Widest at the base so the stack reads as an object being printed layer by
  // layer rather than as a bar chart.
  const layerWidths = [52, 60, 68, 76, 84];
  const layerHeight = 6;
  const layerGap = 3;
  const layerTop = 30;

  const trackWidth = 184;
  const trackHeight = 3;
  const trackTop = 126;
  const sweepWidth = 46;

  const frames = [];
  for (let frame = 0; frame < frameCount; frame += 1) {
    ctx.fillStyle = colors.background;
    ctx.fillRect(0, 0, width, height);

    const litCount = Math.min(
      layerWidths.length,
      Math.floor(frame / (frameCount / (layerWidths.length + 1))),
    );
    layerWidths.forEach((layerWidth, rowFromTop) => {
      const indexFromBottom = layerWidths.length - 1 - rowFromTop;
      ctx.fillStyle = indexFromBottom < litCount ? colors.accent : colors.inert;
      ctx.fillRect(
        Math.round((width - layerWidth) / 2),
        layerTop + rowFromTop * (layerHeight + layerGap),
        layerWidth,
        layerHeight,
      );
    });

    ctx.font = '600 14px "Segoe UI", system-ui, sans-serif';
    ctx.textBaseline = 'alphabetic';
    const lead = 'Installing ';
    const brand = 'PrintFarmer Desktop';
    const leadWidth = ctx.measureText(lead).width;
    const brandWidth = ctx.measureText(brand).width;
    const textLeft = Math.round((width - (leadWidth + brandWidth)) / 2);
    ctx.fillStyle = colors.textMuted;
    ctx.fillText(lead, textLeft, 104);
    ctx.fillStyle = colors.textPrimary;
    ctx.fillText(brand, textLeft + leadWidth, 104);

    const trackLeft = Math.round((width - trackWidth) / 2);
    ctx.fillStyle = colors.inert;
    ctx.fillRect(trackLeft, trackTop, trackWidth, trackHeight);

    // Brightest at the leading edge so the sweep has a direction.
    const head = Math.round(
      -sweepWidth + (frame / frameCount) * (trackWidth + sweepWidth),
    );
    const gradient = ctx.createLinearGradient(head, 0, head + sweepWidth, 0);
    gradient.addColorStop(0, colors.background);
    gradient.addColorStop(1, colors.accent);
    ctx.save();
    ctx.beginPath();
    ctx.rect(trackLeft, trackTop, trackWidth, trackHeight);
    ctx.clip();
    ctx.fillStyle = gradient;
    ctx.fillRect(head, trackTop, sweepWidth, trackHeight);
    ctx.restore();

    const rgba = ctx.getImageData(0, 0, width, height).data;
    let binary = '';
    for (let index = 0; index < rgba.length; index += 4) {
      binary += String.fromCharCode(
        rgba[index],
        rgba[index + 1],
        rgba[index + 2],
      );
    }
    frames.push(btoa(binary));
  }
  return frames;
}

function parseHex(hex) {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

function blend(from, to, ratio) {
  return from.map((channel, index) =>
    Math.round(channel + (to[index] - channel) * ratio),
  );
}

/**
 * GIF allows 256 colours, and antialiased text alone can exceed that. The
 * artwork only ever blends the background toward four known colours, so a fixed
 * set of ramps reproduces every rendered pixel closely and deterministically.
 */
function buildPalette() {
  const background = parseHex(COLORS.background);
  const palette = [background];
  for (const target of [
    COLORS.textPrimary,
    COLORS.accent,
    COLORS.inert,
    COLORS.textMuted,
  ]) {
    const end = parseHex(target);
    for (let step = 1; step <= 60; step += 1) {
      palette.push(blend(background, end, step / 60));
    }
  }
  while (palette.length < 256) palette.push([0, 0, 0]);
  return palette;
}

function quantize(rgb, palette) {
  const cache = new Map();
  const indices = new Uint8Array(rgb.length / 3);
  for (let pixel = 0; pixel < indices.length; pixel += 1) {
    const r = rgb[pixel * 3];
    const g = rgb[pixel * 3 + 1];
    const b = rgb[pixel * 3 + 2];
    const key = (r << 16) | (g << 8) | b;
    const cached = cache.get(key);
    if (cached !== undefined) {
      indices[pixel] = cached;
      continue;
    }
    let best = 0;
    let bestDistance = Infinity;
    for (let index = 0; index < palette.length; index += 1) {
      const [pr, pg, pb] = palette[index];
      const distance =
        (pr - r) * (pr - r) + (pg - g) * (pg - g) + (pb - b) * (pb - b);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = index;
      }
    }
    cache.set(key, best);
    indices[pixel] = best;
  }
  return indices;
}

class BitWriter {
  constructor() {
    this.bytes = [];
    this.current = 0;
    this.bitCount = 0;
  }

  write(code, width) {
    for (let bit = 0; bit < width; bit += 1) {
      this.current |= ((code >> bit) & 1) << this.bitCount;
      this.bitCount += 1;
      if (this.bitCount === 8) {
        this.bytes.push(this.current);
        this.current = 0;
        this.bitCount = 0;
      }
    }
  }

  finish() {
    if (this.bitCount > 0) this.bytes.push(this.current);
    return Uint8Array.from(this.bytes);
  }
}

const MIN_CODE_SIZE = 8;
const CLEAR_CODE = 1 << MIN_CODE_SIZE;
const END_CODE = CLEAR_CODE + 1;
const MAX_CODE_WIDTH = 12;
const MAX_CODE = 1 << MAX_CODE_WIDTH;

// Textbook GIF LZW. Worth the ~50 lines: the flat-colour frames compress by
// roughly two orders of magnitude versus emitting bare literals.
function encodeLzw(pixels) {
  const writer = new BitWriter();
  const dictionary = new Map();
  let codeWidth = MIN_CODE_SIZE + 1;
  let maxCode = (1 << codeWidth) - 1;
  let nextCode = CLEAR_CODE + 2;
  let pendingReset = false;

  const output = (code) => {
    writer.write(code, codeWidth);
    if (pendingReset) {
      codeWidth = MIN_CODE_SIZE + 1;
      maxCode = (1 << codeWidth) - 1;
      pendingReset = false;
    } else if (nextCode > maxCode && codeWidth < MAX_CODE_WIDTH) {
      codeWidth += 1;
      maxCode = codeWidth === MAX_CODE_WIDTH ? MAX_CODE : (1 << codeWidth) - 1;
    }
  };

  output(CLEAR_CODE);
  let prefix = pixels[0];
  for (let index = 1; index < pixels.length; index += 1) {
    const pixel = pixels[index];
    const key = (prefix << 8) | pixel;
    const known = dictionary.get(key);
    if (known !== undefined) {
      prefix = known;
      continue;
    }
    output(prefix);
    prefix = pixel;
    if (nextCode < MAX_CODE) {
      dictionary.set(key, nextCode);
      nextCode += 1;
    } else {
      dictionary.clear();
      nextCode = CLEAR_CODE + 2;
      pendingReset = true;
      output(CLEAR_CODE);
    }
  }
  output(prefix);
  output(END_CODE);
  return writer.finish();
}

function toSubBlocks(data) {
  const out = [];
  for (let offset = 0; offset < data.length; offset += 255) {
    const chunk = data.subarray(offset, offset + 255);
    out.push(chunk.length, ...chunk);
  }
  out.push(0);
  return out;
}

function buildGif(frames, palette) {
  const bytes = [];
  const pushU16 = (value) => bytes.push(value & 0xff, (value >> 8) & 0xff);

  bytes.push(...[...'GIF89a'].map((char) => char.charCodeAt(0)));
  pushU16(WIDTH);
  pushU16(HEIGHT);
  bytes.push(0xf7, 0, 0); // global table, 8-bit, 256 entries
  for (const entry of palette) bytes.push(...entry);

  // Netscape looping extension.
  bytes.push(0x21, 0xff, 0x0b);
  bytes.push(...[...'NETSCAPE2.0'].map((char) => char.charCodeAt(0)));
  bytes.push(0x03, 0x01, 0x00, 0x00, 0x00);

  for (const frame of frames) {
    bytes.push(0x21, 0xf9, 0x04, 0x04); // graphic control, "do not dispose"
    pushU16(FRAME_DELAY_CENTISECONDS);
    bytes.push(0x00, 0x00);

    bytes.push(0x2c);
    pushU16(0);
    pushU16(0);
    pushU16(WIDTH);
    pushU16(HEIGHT);
    bytes.push(0x00);

    bytes.push(MIN_CODE_SIZE);
    bytes.push(...toSubBlocks(encodeLzw(frame)));
  }

  bytes.push(0x3b);
  return Buffer.from(bytes);
}

async function main() {
  await app.whenReady();
  const window = new BrowserWindow({
    show: false,
    width: WIDTH,
    height: HEIGHT,
  });
  await window.loadURL('data:text/html,<html><body></body></html>');

  const config = {
    width: WIDTH,
    height: HEIGHT,
    frameCount: FRAME_COUNT,
    colors: COLORS,
  };
  const encoded = await window.webContents.executeJavaScript(
    `(${drawFrames.toString()})(${JSON.stringify(config)})`,
  );

  const palette = buildPalette();
  const frames = encoded.map((base64) =>
    quantize(Buffer.from(base64, 'base64'), palette),
  );

  const target = fileURLToPath(
    new URL('../assets/installing.gif', import.meta.url),
  );
  writeFileSync(target, buildGif(frames, palette));
  console.log(`wrote ${target}`);
  app.quit();
}

main().catch((error) => {
  console.error(error);
  app.exit(1);
});
