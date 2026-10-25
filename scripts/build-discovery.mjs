import { mkdir, readFile, writeFile, cp, rm, mkdtemp } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = 'native/discovery.c';
const recipe = 'scripts/build-discovery.mjs';
const files = ['tizen-discovery.js', 'tizen-discovery.wasm', 'LICENSE'];
const output = 'app/vendor/discovery';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const help = 'TV discovery needs the Samsung Emscripten SDK. Activate it, then run SAMSUNG_EMCC=/path/to/emsdk/fastcomp/emscripten/emcc npm run build:discovery. See docs/INSTALL.md.';

export const discoveryFlags = [
  '-Os', '-s', 'ENVIRONMENT_MAY_BE_TIZEN=1', '-s', 'ENVIRONMENT=worker',
  '-s', 'MODULARIZE=1', '-s', 'EXPORT_NAME=createTizenDiscovery',
  '-s', 'NO_EXIT_RUNTIME=1',
  '-s', 'EXPORTED_FUNCTIONS=["_discovery_open","_discovery_close","_discovery_buffer","_discovery_sender","_discovery_send","_discovery_send_reolink","_discovery_receive"]',
  '-s', 'EXTRA_EXPORTED_RUNTIME_METHODS=["UTF8ToString"]'
];

export async function checkDiscovery(root = project) {
  try {
    const manifest = JSON.parse(await readFile(resolve(root, output, 'build.json'), 'utf8'));
    for (const name of [source, recipe]) {
      if (manifest.inputs?.[name] !== sha256(await readFile(resolve(root, name)))) throw new Error('TV discovery source changed; rebuild the module.');
    }
    for (const name of files) {
      const bytes = await readFile(resolve(root, output, name));
      if (manifest.files?.[name] !== sha256(bytes)) throw new Error('TV discovery output changed; rebuild the module.');
      if (name.endsWith('.wasm') && !WebAssembly.validate(bytes)) throw new Error('Invalid TV discovery WebAssembly module.');
    }
    return { ready: true };
  } catch (error) {
    return { ready: false, message: error.code === 'ENOENT' ? help : `${error.message} ${help}` };
  }
}

export async function buildDiscovery(root = project) {
  const emcc = process.env.SAMSUNG_EMCC;
  if (!emcc) throw new Error(help);
  const compiler = resolve(emcc);
  // Keep the generated runtime's upstream license alongside the bundled files.
  const license = await readFile(join(dirname(compiler), 'LICENSE'));
  const version = spawnSync(compiler, ['--version'], { encoding: 'utf8' });
  if (version.error || version.status !== 0) throw new Error(`Could not run Samsung emcc. ${help}`);
  await mkdir(resolve(root, '.cache'), { recursive: true });
  const temporary = await mkdtemp(resolve(root, '.cache/discovery-'));
  try {
    // The Samsung-only setting intentionally makes stock Emscripten fail rather
    // than producing its WebSocket-based socket emulation, which cannot scan a LAN.
    const result = spawnSync(compiler, [resolve(root, source), ...discoveryFlags,
      '-o', resolve(temporary, files[0])], { cwd: root, stdio: 'inherit' });
    if (result.error || result.status !== 0) throw new Error('TV discovery compilation failed. Use Samsung Emscripten 1.39.4.7, not stock Emscripten.');
    await writeFile(join(temporary, 'LICENSE'), license);
    const manifest = { compiler: version.stdout.split('\n')[0], inputs: {}, files: {} };
    for (const name of [source, recipe]) manifest.inputs[name] = sha256(await readFile(resolve(root, name)));
    for (const name of files) {
      const bytes = await readFile(join(temporary, name));
      if (name.endsWith('.wasm') && !WebAssembly.validate(bytes)) throw new Error('Compiler produced an invalid WebAssembly module.');
      manifest.files[name] = sha256(bytes);
    }
    await writeFile(join(temporary, 'build.json'), JSON.stringify(manifest, null, 2) + '\n');
    await mkdir(resolve(root, output), { recursive: true });
    for (const name of [...files, 'build.json']) await cp(join(temporary, name), resolve(root, output, name));
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await buildDiscovery();
    console.log('Built and bundled the TV discovery runtime. No desktop server is needed on the TV.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
