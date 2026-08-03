// Squirrel shows a single animated GIF for the whole silent install, and its
// bundled default is a pale-green spinner that looks nothing like the app. This
// renders a branded replacement from scratch so the asset is reproducible and
// reviewable as code rather than an opaque binary someone dropped in `assets/`.
//
// Run with: node scripts/generate-installer-gif.mjs

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const WIDTH = 268;
const HEIGHT = 167;
const FRAME_COUNT = 24;
const FRAME_DELAY_CENTISECONDS = 6;

// Palette entries are referenced by index below; keep the order stable.
const BACKGROUND = 0;
const INERT = 1;
const ACCENT_RAMP_START = 2;
const ACCENT_RAMP_LENGTH = 8;

const PALETTE = [
  [0x0e, 0x11, 0x16], // app background
  [0x1b, 0x20, 0x29], // unbuilt layer / progress track
  [0x24, 0x35, 0x45],
  [0x2e, 0x49, 0x60],
  [0x39, 0x5d, 0x7b],
  [0x45, 0x72, 0x97],
  [0x53, 0x89, 0xb3],
  [0x63, 0xa0, 0xcd],
  [0x74, 0xb4, 0xe0],
  [0x86, 0xc7, 0xf2], // full accent
];

const ACCENT = ACCENT_RAMP_START + ACCENT_RAMP_LENGTH - 1;

function createCanvas() {
  return new Uint8Array(WIDTH * HEIGHT).fill(BACKGROUND);
}

function fillRect(canvas, x, y, width, height, colorIndex) {
  const left = Math.max(0, x);
  const top = Math.max(0, y);
  const right = Math.min(WIDTH, x + width);
  const bottom = Math.min(HEIGHT, y + height);
  for (let row = top; row < bottom; row += 1) {
    canvas.fill(colorIndex, row * WIDTH + left, row * WIDTH + right);
  }
}

// A stack of bars that lights up bottom-up, echoing a part being printed layer
// by layer. Widest at the base so it reads as an object rather than a chart.
const LAYER_WIDTHS = [52, 60, 68, 76, 84];
const LAYER_HEIGHT = 6;
const LAYER_GAP = 3;
const LAYER_STACK_TOP = 46;

function drawLayerStack(canvas, litCount) {
  LAYER_WIDTHS.forEach((width, rowFromTop) => {
    const y = LAYER_STACK_TOP + rowFromTop * (LAYER_HEIGHT + LAYER_GAP);
    const indexFromBottom = LAYER_WIDTHS.length - 1 - rowFromTop;
    const lit = indexFromBottom < litCount;
    fillRect(
      canvas,
      Math.round((WIDTH - width) / 2),
      y,
      width,
      LAYER_HEIGHT,
      lit ? ACCENT : INERT,
    );
  });
}

const TRACK_WIDTH = 184;
const TRACK_HEIGHT = 3;
const TRACK_TOP = 112;
const SWEEP_WIDTH = 46;

function drawProgressSweep(canvas, progress) {
  const trackLeft = Math.round((WIDTH - TRACK_WIDTH) / 2);
  fillRect(canvas, trackLeft, TRACK_TOP, TRACK_WIDTH, TRACK_HEIGHT, INERT);

  const travel = TRACK_WIDTH + SWEEP_WIDTH;
  const head = Math.round(-SWEEP_WIDTH + progress * travel);
  for (let offset = 0; offset < SWEEP_WIDTH; offset += 1) {
    const x = head + offset;
    if (x < trackLeft || x >= trackLeft + TRACK_WIDTH) continue;
    // Brightest at the leading edge so the sweep has a direction.
    const ramp = Math.floor((offset / SWEEP_WIDTH) * ACCENT_RAMP_LENGTH);
    fillRect(canvas, x, TRACK_TOP, 1, TRACK_HEIGHT, ACCENT_RAMP_START + ramp);
  }
}

function renderFrame(frameIndex) {
  const canvas = createCanvas();
  const litCount = Math.min(
    LAYER_WIDTHS.length,
    Math.floor(frameIndex / (FRAME_COUNT / (LAYER_WIDTHS.length + 1))),
  );
  drawLayerStack(canvas, litCount);
  drawProgressSweep(canvas, frameIndex / FRAME_COUNT);
  return canvas;
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

// Textbook GIF LZW. Worth the ~60 lines: the flat-colour frames compress by
// roughly three orders of magnitude versus emitting bare literals.
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

function buildGif() {
  const bytes = [];
  const pushU16 = (value) => bytes.push(value & 0xff, (value >> 8) & 0xff);

  bytes.push(...[...'GIF89a'].map((char) => char.charCodeAt(0)));
  pushU16(WIDTH);
  pushU16(HEIGHT);
  bytes.push(0xf7, BACKGROUND, 0); // global table, 8-bit, 256 entries
  for (let index = 0; index < 256; index += 1) {
    bytes.push(...(PALETTE[index] ?? [0, 0, 0]));
  }

  // Netscape looping extension.
  bytes.push(0x21, 0xff, 0x0b);
  bytes.push(...[...'NETSCAPE2.0'].map((char) => char.charCodeAt(0)));
  bytes.push(0x03, 0x01, 0x00, 0x00, 0x00);

  for (let frame = 0; frame < FRAME_COUNT; frame += 1) {
    bytes.push(0x21, 0xf9, 0x04, 0x04); // graphic control, disposal "do not dispose"
    pushU16(FRAME_DELAY_CENTISECONDS);
    bytes.push(0x00, 0x00);

    bytes.push(0x2c);
    pushU16(0);
    pushU16(0);
    pushU16(WIDTH);
    pushU16(HEIGHT);
    bytes.push(0x00);

    bytes.push(MIN_CODE_SIZE);
    bytes.push(...toSubBlocks(encodeLzw(renderFrame(frame))));
  }

  bytes.push(0x3b);
  return Buffer.from(bytes);
}

const target = fileURLToPath(
  new URL('../assets/installing.gif', import.meta.url),
);
writeFileSync(target, buildGif());
console.log(`wrote ${target}`);
