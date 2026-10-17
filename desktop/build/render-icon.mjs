// Renders icon-body.svg into the PNGs electron-builder turns into .icns and .ico:
//   icon.png      1024², the macOS grid (an 824 tile centred, with its shadow)
//   icon-win.png  1024², nearly full-bleed, for Windows and the runtime window icon
// Run with: npx electron build/render-icon.mjs
import { app, BrowserWindow } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
app.commandLine.appendSwitch('force-device-scale-factor', '1');

// The macOS shadow is a blurred tile drawn behind, not a filter over the whole group,
// which Chromium rasterises in bands.
function frame(body, { offset, scale, shadow }) {
  const drop = shadow
    ? '<defs><filter id="tileshadow" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="14"/></filter></defs>'
      + `<rect x="${offset}" y="${offset + 12}" width="${824 * scale}" height="${824 * scale}" rx="${185 * scale}" fill="#000" fill-opacity="0.32" filter="url(#tileshadow)"/>`
    : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024" style="display:block">${drop}`
    + `<g transform="translate(${offset} ${offset}) scale(${scale})">${body}</g></svg>`;
}

app.whenReady().then(async () => {
  const body = await readFile(path.join(HERE, 'icon-body.svg'), 'utf8');
  const targets = {
    'icon.png': frame(body, { offset: 100, scale: 1, shadow: true }),
    'icon-win.png': frame(body, { offset: 24, scale: 976 / 824, shadow: false }),
  };
  const window = new BrowserWindow({ width: 1024, height: 1024, show: false, transparent: true, frame: false, backgroundColor: '#00000000', webPreferences: { offscreen: true } });
  for (const [name, svg] of Object.entries(targets)) {
    const html = `<!doctype html><html><body style="margin:0;overflow:hidden;background:transparent">${svg}</body></html>`;
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    await new Promise(resolve => setTimeout(resolve, 300));
    const image = await window.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
    await writeFile(path.join(HERE, name), image.toPNG());
    console.log(`${name}: ${image.getSize().width}x${image.getSize().height}`);
  }
  app.exit(0);
});
