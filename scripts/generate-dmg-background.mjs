// Run on macOS: npx electron scripts/generate-dmg-background.mjs
// Optional: --preview-dir /absolute/path for a composed layout (not Finder).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { app, BrowserWindow, nativeImage } from 'electron';

const root = path.resolve(import.meta.dirname, '..');
const assetDir = path.join(root, 'assets', 'dmg');
const previewIndex = process.argv.indexOf('--preview-dir');
const previewDir =
  previewIndex === -1 ? undefined : process.argv[previewIndex + 1];
if (previewIndex !== -1 && (!previewDir || !path.isAbsolute(previewDir))) {
  throw new Error('--preview-dir requires an absolute directory');
}

/* global Image, document */
function render({ svg, scale, icons }) {
  return (async () => {
    const load = async (source) => {
      const image = new Image();
      image.src = source;
      await image.decode();
      return image;
    };
    const canvas = document.createElement('canvas');
    canvas.width = 680 * scale;
    canvas.height = 460 * scale;
    const ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);
    ctx.drawImage(await load(svg), 0, 0, 680, 460);
    if (icons) {
      ctx.textAlign = 'center';
      ctx.font = '13px -apple-system, BlinkMacSystemFont, sans-serif';
      for (const { image, x, label } of icons) {
        ctx.drawImage(await load(image), x - 48, 232, 96, 96);
        ctx.fillStyle = '#172c47';
        ctx.fillText(label, x, 350);
      }
    }
    return canvas.toDataURL('image/png').split(',')[1];
  })();
}

async function main() {
  await app.whenReady();
  const window = new BrowserWindow({
    show: false,
    webPreferences: { offscreen: true, contextIsolation: true, sandbox: true },
  });
  await window.loadURL('about:blank');
  const svg = `data:image/svg+xml;base64,${readFileSync(path.join(assetDir, 'background.svg')).toString('base64')}`;
  for (const scale of [1, 2]) {
    const png = await window.webContents.executeJavaScript(
      `(${render.toString()})(${JSON.stringify({ svg, scale })})`,
    );
    writeFileSync(
      path.join(assetDir, `background${scale === 2 ? '@2x' : ''}.png`),
      Buffer.from(png, 'base64'),
    );
  }
  if (previewDir) {
    mkdirSync(previewDir, { recursive: true });
    const folderPath = path.join(previewDir, 'applications-icon.png');
    execFileSync('/usr/bin/sips', [
      '-s',
      'format',
      'png',
      '/System/Library/CoreServices/CoreTypes.bundle/Contents/Resources/ApplicationsFolderIcon.icns',
      '--out',
      folderPath,
    ]);
    const folder = nativeImage.createFromPath(folderPath);
    if (folder.isEmpty())
      throw new Error('Cannot read Applications folder icon');
    const icons = [
      {
        image: nativeImage
          .createFromPath(path.join(root, 'assets', 'icon.png'))
          .toDataURL(),
        x: 180,
        label: 'PrintFarmer Desktop',
      },
      { image: folder.toDataURL(), x: 500, label: 'Applications' },
    ];
    const png = await window.webContents.executeJavaScript(
      `(${render.toString()})(${JSON.stringify({ svg, scale: 2, icons })})`,
    );
    writeFileSync(
      path.join(previewDir, 'dmg-preview.png'),
      Buffer.from(png, 'base64'),
    );
  }
  window.destroy();
  app.quit();
}

main().catch((error) => {
  console.error(error);
  app.exit(1);
});
