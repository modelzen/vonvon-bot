import { execFile } from 'node:child_process';
import { readFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { chromium } from 'playwright';

const run = promisify(execFile);
const cli = resolve('packages/daemon/bin/vonvon.mjs');
const home = process.env.VONVON_HOME;
if (!home || !home.startsWith('/')) throw new Error('Set an isolated absolute VONVON_HOME.');

async function owner() {
  const { stdout } = await run(process.execPath, [cli, 'daemon', 'status', '--json']);
  const status = JSON.parse(stdout);
  if (!status.running || !/^127\.0\.0\.1:\d{1,5}$/.test(status.listen)) throw new Error('Owned daemon is not running on loopback.');
  return status;
}

async function doctor() {
  const status = await owner();
  const credential = (await readFile(resolve(home, 'local-credential'), 'utf8')).trim();
  if (!/^[a-f0-9]{64}$/i.test(credential)) throw new Error('Local credential is missing or invalid.');
  const response = await fetch(`http://${status.listen}/`);
  if (!response.ok || !(await response.text()).includes('Vonvon Bot')) throw new Error('Built UI is not served by the owned daemon.');
  process.stdout.write(`ready PID ${status.pid} at ${status.listen}\n`);
  return { status, credential };
}

const [command, feature, target] = process.argv.slice(2);
if (command === 'doctor') await doctor();
else if (command === 'capture') {
  if (!['bot-list', 'no-cred'].includes(feature) || !target?.startsWith('/')) throw new Error('Use capture bot-list|no-cred /absolute/path.png');
  const { status, credential } = await doctor();
  await mkdir(dirname(target), { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    const base = `http://${status.listen}/`;
    await page.goto(feature === 'no-cred' ? base : `${base}#credential=${credential}`);
    if (feature === 'no-cred') await page.getByRole('heading', { name: '需要本机访问凭证' }).waitFor();
    else {
      await page.getByRole('navigation', { name: '主要导航' }).waitFor();
      if (new URL(page.url()).hash) throw new Error('Credential fragment remains in address bar.');
    }
    await page.screenshot({ path: target, fullPage: true });
    process.stdout.write(`captured ${feature} at ${target}\n`);
  } finally { await browser.close(); }
} else throw new Error('Use doctor or capture.');
