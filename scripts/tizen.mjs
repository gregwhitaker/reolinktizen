import { existsSync, readdirSync, copyFileSync, readFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join, basename } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { checkDiscovery } from './build-discovery.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const appId = 'ReolinkTV1.Viewer';
const args = process.argv.slice(2);
const command = args[0] || 'doctor';
function option(name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; }
function findTool(name, override, paths) {
  const candidates = [override, ...paths, ...(process.env.PATH || '').split(':').map(p => join(p, name))].filter(Boolean);
  return candidates.find(p => existsSync(p)) || null;
}
const tizen = findTool('tizen', process.env.TIZEN_CLI, [join(homedir(), 'tizen-studio/tools/ide/bin/tizen'), '/opt/tizen-studio/tools/ide/bin/tizen']);
const sdb = findTool('sdb', process.env.SDB, [join(homedir(), 'tizen-studio/tools/sdb'), join(homedir(), 's90c-root/data/tools/sdb'), '/opt/tizen-studio/tools/sdb']);
function run(executable, arguments_, timeout = 120000) {
  const result = spawnSync(executable, arguments_, { cwd: root, stdio: 'inherit', timeout });
  if (result.error || result.status !== 0) throw new Error(`${basename(executable)} did not complete successfully${result.error?.code === 'ETIMEDOUT' ? ' (timed out)' : ''}.`);
}
function requireTizen() {
  if (!tizen) throw new Error('Tizen CLI not found. Install Tizen Studio + TV Extension + Samsung Certificate Extension, or set TIZEN_CLI. See docs/INSTALL.md.');
}
function signedPackage() {
  const location = resolve(root, option('--file') || 'artifacts/ReolinkTV.wgt');
  if (!existsSync(location)) throw new Error('No signed widget found. First run: npm run sign -- --profile YOUR_PROFILE');
  // The signature is checked by the TV. Here, prevent accidentally installing our unsigned archive.
  const bytes = readFileSync(location);
  if (!bytes.includes(Buffer.from('author-signature.xml')) || !bytes.includes(Buffer.from('signature1.xml'))) {
    throw new Error('This widget is unsigned. A Samsung TV certificate profile is required.');
  }
  return location;
}
try {
  if (command === 'doctor') {
    console.log(`Tizen CLI: ${tizen || 'not installed'}`);
    console.log(`SDB: ${sdb || 'not installed'}`);
    const discovery = await checkDiscovery(root);
    console.log(`TV discovery: ${discovery.ready ? 'bundled' : discovery.message}`);
    console.log(`Built app: ${existsSync(resolve(root, 'dist/config.xml')) ? 'yes' : 'run npm run build'}`);
    console.log('Next: npm run sign -- --profile YOUR_SAMSUNG_PROFILE');
    console.log('Then: npm run install:tv -- --tv TV_IP');
    if (sdb && args.includes('--devices')) run(sdb, ['devices'], 8000);
  } else if (command === 'sign') {
    requireTizen();
    const profile = option('--profile') || process.env.TIZEN_PROFILE;
    if (!profile || profile.startsWith('-')) throw new Error('Pass --profile with the Samsung TV certificate profile name from Certificate Manager.');
    run(process.execPath, [resolve(root, 'scripts/build.mjs'), '--tv']);
    run(tizen, ['package', '-t', 'wgt', '-s', profile, '--', resolve(root, 'dist')]);
    const files = readdirSync(resolve(root, 'dist')).filter(file => file.endsWith('.wgt'));
    if (files.length !== 1) throw new Error('Expected one signed widget in dist/. Check the Tizen CLI output.');
    mkdirSync(resolve(root, 'artifacts'), { recursive: true });
    copyFileSync(resolve(root, 'dist', files[0]), resolve(root, 'artifacts/ReolinkTV.wgt'));
    signedPackage();
    console.log('Signed artifacts/ReolinkTV.wgt');
  } else if (command === 'install') {
    requireTizen();
    if (!sdb) throw new Error('SDB not found. Set SDB to the binary’s path.');
    const target = option('--tv');
    if (!target || !/^[a-zA-Z0-9.:-]+$/.test(target) || target.startsWith('-')) throw new Error('Pass --tv with the TV’s IP address (for example, --tv 192.168.1.50).');
    const serial = target.includes(':') ? target : `${target}:26101`;
    const file = signedPackage();
    run(sdb, ['connect', serial], 15000);
    run(tizen, ['install', '-s', serial, '-n', basename(file), '--', dirname(file)]);
    run(tizen, ['run', '-s', serial, '-p', appId], 30000);
    console.log('Installed and launched Reolink TV. Enter your NVR login on the TV.');
  } else throw new Error(`Unknown command: ${command}`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
