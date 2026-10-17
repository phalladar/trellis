// Renames the local unpackaged Electron app bundle in node_modules/electron on macOS
// so that the process name, dock, menu bar, and system dialogs display "Trellis" instead of "Electron".
import { execSync } from 'node:child_process';
import { existsSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

if (process.platform === 'darwin') {
  const electronDir = path.join(ROOT, 'node_modules', 'electron');
  const distDir = path.join(electronDir, 'dist');
  const electronApp = path.join(distDir, 'Electron.app');
  const trellisApp = path.join(distDir, 'Trellis.app');

  if (existsSync(electronApp) && !existsSync(trellisApp)) {
    try {
      renameSync(electronApp, trellisApp);
    } catch (err) {
      console.warn('Could not rename Electron.app to Trellis.app:', err.message);
    }
  }

  const targetApp = existsSync(trellisApp) ? trellisApp : (existsSync(electronApp) ? electronApp : null);
  if (targetApp) {
    const oldExec = path.join(targetApp, 'Contents', 'MacOS', 'Electron');
    const newExec = path.join(targetApp, 'Contents', 'MacOS', 'Trellis');
    if (existsSync(oldExec) && !existsSync(newExec)) {
      try {
        renameSync(oldExec, newExec);
      } catch (err) {
        console.warn('Could not rename Electron binary to Trellis:', err.message);
      }
    }

    const plist = path.join(targetApp, 'Contents', 'Info.plist');
    if (existsSync(plist)) {
      try {
        execSync(`plutil -replace CFBundleName -string "Trellis" "${plist}"`);
        execSync(`plutil -replace CFBundleDisplayName -string "Trellis" "${plist}"`);
        execSync(`plutil -replace CFBundleExecutable -string "Trellis" "${plist}"`);
      } catch (err) {
        console.warn('Could not update Info.plist:', err.message);
      }
    }

    const pathTxt = path.join(electronDir, 'path.txt');
    const appBase = path.basename(targetApp);
    const execName = existsSync(newExec) ? 'Trellis' : 'Electron';
    try {
      writeFileSync(pathTxt, `${appBase}/Contents/MacOS/${execName}`);
    } catch (err) {
      console.warn('Could not update path.txt:', err.message);
    }
  }
}
