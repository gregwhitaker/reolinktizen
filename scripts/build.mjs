import { cp, mkdir, rm, readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');
const required = ['index.html', 'config.xml', 'styles.css', 'js/app.js', 'vendor/mpegts.js', 'vendor/mpegts.LICENSE', 'assets/icon.png'];
for (const name of required) await readFile(resolve(root, 'app', name));
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await cp(resolve(root, 'app'), dist, { recursive: true });
console.log('Built dist/ — self-contained Tizen TV web app.');

if (process.argv.includes('--package')) {
  await mkdir(resolve(root, 'artifacts'), { recursive: true });
  const result = spawnSync('python3', [resolve(root, 'scripts/package.py')], { cwd: root, stdio: 'inherit' });
  if (result.error || result.status !== 0) { console.error('Packaging needs Python 3. Build output remains in dist/.'); process.exit(1); }
}
