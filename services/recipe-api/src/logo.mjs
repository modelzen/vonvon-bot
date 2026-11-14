import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { decoderEnvironment, linuxDecoderLaunch } from './logo-sandbox.mjs';
import { ApiError } from './errors.mjs';

const worker = fileURLToPath(new URL('./logo-child.mjs',import.meta.url));
let active = 0;

async function decode(bytes, mode) {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > (mode === 'check' ? 131072 : 2097152)) {
    throw new ApiError(422,'invalid_logo');
  }
  if (active >= 2) throw new ApiError(429,'logo_decoder_busy',1);
  if (!['linux','darwin'].includes(process.platform)) throw new ApiError(503,'logo_decoder_unavailable');
  const linux = process.platform === 'linux';
  const limits = linux ? 'ulimit -v 1572864 && ulimit -d 393216 && ' : '';
  const command = limits + 'ulimit -c 0 && ulimit -t 4 && exec "$@"';
  let launch;
  try { launch = linux ? linuxDecoderLaunch(mode) : {command:process.execPath,args:['--jitless','--max-old-space-size=48',worker,mode]}; }
  catch { throw new ApiError(503,'logo_decoder_unavailable'); }
  active++;
  try {
    return await new Promise((resolve,reject) => {
      const child = spawn('/bin/sh',['-c',command,'logo',launch.command,...launch.args],{
        cwd:'/',env:decoderEnvironment,stdio:['pipe','pipe','pipe'],
      });
      child.stderr.resume();
      const chunks = [];
      let size = 0;
      const stop = () => child.kill('SIGKILL');
      const timer = setTimeout(stop,5000);
      let sampling = false;
      const rss = linux ? undefined : setInterval(() => {
        if (!sampling && child.pid) {
          sampling = true;
          execFile('/bin/ps',['-o','rss=','-p',String(child.pid)],{timeout:300},(error,stdout) => {
            sampling = false;
            if (!error && Number(stdout.trim()) > 256*1024) stop();
          });
        }
      },50);
      child.stdout.on('data',chunk => {
        size += chunk.length;
        if (size > 131072) stop();
        else chunks.push(chunk);
      });
      child.stdin.on('error',() => {});
      child.on('error',() => reject(new ApiError(503,'logo_decoder_unavailable')));
      child.once('close',code => {
        clearTimeout(timer);
        clearInterval(rss);
        if (linux && code === 1) reject(new ApiError(503,'logo_decoder_unavailable'));
        else if (code !== 0 || size > 131072 || (mode !== 'check' && size === 0)) reject(new ApiError(422,'invalid_logo'));
        else resolve(Buffer.concat(chunks,size));
      });
      child.stdin.end(bytes);
    });
  } finally { active--; }
}

export const normalizeLogo = bytes => decode(bytes,'normalize');
export const verifyNormalizedLogo = bytes => decode(bytes,'check');
