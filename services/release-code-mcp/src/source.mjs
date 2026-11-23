import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';

const MAX_BYTES = 32 * 1024;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
export class QueryError extends Error {}
function invalid() {
  throw new QueryError('Unsupported arguments. Use a relative path and the documented read-only options.');
}

function relativePath(path) {
  if (
    !path ||
    path.length > 1024 ||
    isAbsolute(path) ||
    path.startsWith('-') ||
    /[\\:\x00-\x1f\x7f]/u.test(path) ||
    path.split('/').some((s) => s === '..' || (s.startsWith('.') && s !== '.'))
  )
    invalid();
  return path;
}
async function targetPath(tree, path) {
  const absolute = join(tree, relativePath(path));
  let canonical;
  try {
    canonical = await realpath(absolute);
  } catch {
    throw new QueryError('Path not found in this release.');
  }
  if (canonical !== absolute) throw new QueryError('Linked paths cannot be read.');
  return absolute;
}

async function snapshot(root) {
  const base = await realpath(root);
  const release = await realpath(join(base, 'current'));
  const child = relative(base, release);
  if (!child || child === '..' || child.startsWith('..' + sep) || isAbsolute(child))
    throw new Error('Invalid published release');
  const tree = join(release, 'tree');
  if ((await realpath(tree)) !== tree || !(await stat(tree)).isDirectory())
    throw new Error('Invalid published tree');
  const manifest = await open(
    join(release, 'release.json'),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    const metadata = await manifest.stat();
    if (!metadata.isFile() || metadata.size > 4096) throw new Error('Invalid release metadata');
    const { version, sourceSha } = JSON.parse(await manifest.readFile('utf8'));
    if (
      typeof version !== 'string' ||
      !/^\d+\.\d+\.\d+(?:[-+][\w.+-]+)?$/u.test(version) ||
      !/^[a-f0-9]{40}$/u.test(sourceSha)
    )
      throw new Error('Invalid release metadata');
    return { tree, release, version, sourceSha, dev: metadata.dev, ino: metadata.ino };
  } finally {
    await manifest.close();
  }
}

async function readLines(tree, { path, offset = 1, limit = 200 }) {
  const absolute = await targetPath(tree, path);
  const file = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size > MAX_FILE_BYTES)
      throw new QueryError('Choose a text file smaller than 16 MiB.');
    const data = await file.readFile();
    if (data.includes(0)) throw new QueryError('Only text files are supported.');
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let bytes = 0,
      totalLines = 0,
      full = false;
    const output = [];
    for (let start = 0; start < data.length; ) {
      const newline = data.indexOf(10, start);
      const end = newline < 0 ? data.length : newline;
      totalLines++;
      if (!full && totalLines >= offset && output.length < limit) {
        const length = end - start + String(totalLines).length + 2;
        if (bytes + length > MAX_BYTES) {
          if (!output.length)
            throw new QueryError('Line exceeds the response limit; search for a shorter matching excerpt.');
          full = true;
        } else {
          const body = data.subarray(start, end > start && data[end - 1] === 13 ? end - 1 : end);
          try {
            output.push(totalLines + '\t' + decoder.decode(body));
          } catch {
            throw new QueryError('Only UTF-8 text files are supported.');
          }
          bytes += length;
        }
      }
      start = end + 1;
    }
    return {
      path,
      offset,
      totalLines,
      text: output.join('\n'),
      nextOffset: offset + output.length <= totalLines ? offset + output.length : null,
    };
  } finally {
    await file.close();
  }
}

function boundedInteger(raw, max) {
  if (typeof raw !== 'string' || !/^\d{1,3}$/u.test(raw) || Number(raw) > max) invalid();
  return raw;
}
export function parseRg(argv) {
  const options = [],
    args = [];
  let files = false,
    literal = false,
    expression;
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v.includes('\0')) invalid();
    if (literal || !v.startsWith('-')) {
      args.push(v);
      continue;
    }
    if (v === '--') {
      literal = true;
      continue;
    }
    if (v === '--files') {
      files = true;
      continue;
    }
    if (
      /^-[iFnwl]+$/u.test(v) ||
      ['--ignore-case', '--fixed-strings', '--line-number', '--word-regexp', '--files-with-matches'].includes(v)
    ) {
      options.push(v);
      continue;
    }
    if (v === '-e' || v === '--regexp') {
      if (expression !== undefined || typeof argv[++i] !== 'string') invalid();
      expression = argv[i];
      continue;
    }
    if (v.startsWith('-g') || v === '--glob' || v.startsWith('--glob=')) {
      const glob = v === '-g' || v === '--glob' ? argv[++i] : v.startsWith('-g') ? v.slice(2) : v.slice(7);
      if (!glob || glob.includes('\0') || glob.length > 160) invalid();
      options.push('--glob=' + glob);
      continue;
    }
    if (['-C', '-A', '-B', '--context', '--after-context', '--before-context', '--max-depth'].includes(v)) {
      options.push(v, boundedInteger(argv[++i], v === '--max-depth' ? 128 : 10));
      continue;
    }
    const attached = /^(-[ABC])(\d+)$|^(--context|--after-context|--before-context|--max-depth)=(\d+)$/u.exec(v);
    if (attached) {
      const name = attached[1] ?? attached[3];
      options.push(name, boundedInteger(attached[2] ?? attached[4], name === '--max-depth' ? 128 : 10));
      continue;
    }
    invalid();
  }
  if (files && expression !== undefined) invalid();
  if (!files && expression === undefined) expression = args.shift();
  if (!files && (!expression || expression.length > 1024 || expression.includes('\0'))) invalid();
  const paths = args.length ? args.map(relativePath) : ['.'];
  return {
    paths,
    args: [
      '--no-config',
      '--no-follow',
      '--color',
      'never',
      '--threads',
      '1',
      '--max-filesize',
      '16M',
      ...(files
        ? ['--files']
        : ['--line-number', '--with-filename', '--no-heading', '--max-columns', '500', '--max-columns-preview']),
      ...options,
      ...(files ? [] : ['-e', expression]),
      '--',
      ...paths,
    ],
  };
}

async function runRg(exe, tree, argv, signal) {
  const query = parseRg(argv);
  for (const path of query.paths) {
    const info = await stat(await targetPath(tree, path));
    if (!info.isDirectory() && !info.isFile()) throw new QueryError('Choose a regular file or directory.');
  }
  return new Promise((resolve, reject) => {
    const child = spawn(exe, query.args, {
      cwd: tree,
      shell: false,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { PATH: process.env.PATH, LC_ALL: 'C' },
      signal,
    });
    const chunks = [];
    let bytes = 0,
      truncated = false,
      timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, 4000);
    child.stdout.on('data', (chunk) => {
      if (truncated) return;
      const size = Math.min(chunk.length, MAX_BYTES - bytes);
      chunks.push(chunk.subarray(0, size));
      bytes += size;
      if (size < chunk.length) {
        truncated = true;
        child.kill('SIGKILL');
      }
    });
    child.once('error', () => {
      clearTimeout(timer);
      reject(new QueryError('Search could not complete.'));
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new QueryError('Search timed out; narrow the directory or pattern.'));
      if (!truncated && code !== 0 && code !== 1)
        return reject(new QueryError('Search failed; check the pattern and path.'));
      const data = Buffer.concat(chunks, bytes);
      const end = truncated ? Math.max(0, data.lastIndexOf(10) + 1) : bytes;
      resolve({ text: data.subarray(0, end).toString('utf8'), truncated });
    });
  });
}

export function sourceLibrary({ root, rg = 'rg' }) {
  return {
    async info() {
      const { version, sourceSha } = await snapshot(root);
      return { version, sourceSha };
    },
    async query(tool, args, signal) {
      const release = await snapshot(root);
      const result =
        tool === 'read' ? await readLines(release.tree, args) : await runRg(rg, release.tree, args.argv, signal);
      // The publisher normally points "current" at an immutable version directory. Reject a
      // direct-directory replacement during a read too: do not label mixed bytes as one version.
      const after = await stat(join(release.release, 'release.json'));
      if (after.dev !== release.dev || after.ino !== release.ino) throw new QueryError('Release changed; retry.');
      return { version: release.version, sourceSha: release.sourceSha, ...result };
    },
  };
}
