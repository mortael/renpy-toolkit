import { cpSync, existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';

const src = join('node_modules', 'pyodide');
const dest = join('public', 'pyodide');

if (!existsSync(src)) {
  console.warn('sync-pyodide: pyodide not installed — Save Editor will use CDN fallback');
  process.exit(0);
}

if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
mkdirSync(join('public'), { recursive: true });
cpSync(src, dest, { recursive: true });
console.log('sync-pyodide: copied node_modules/pyodide → public/pyodide');