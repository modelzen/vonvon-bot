#!/usr/bin/env node
// Compiles vonvon-holder into the dist path bootstrap resolves. Not part of `npm run build`: native distribution is
// packaging's job (providers.md *Native distribution*); this is the development and Lane 10 build.
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const source = join(root, 'native', 'holder', 'holder.c');
const out = join(root, 'dist', 'native', `${process.platform}-${process.arch}`, 'vonvon-holder');
// The same flags test/provider/native/holder-driver.ts uses.
const flags = ['-std=c11', '-D_DEFAULT_SOURCE', '-D_DARWIN_C_SOURCE', '-Wall', '-Wextra', '-Werror', '-O2'];
mkdirSync(dirname(out), { recursive: true });
execFileSync(process.env.CC ?? 'cc', [...flags, source, '-o', out], { stdio: 'inherit' });
console.log(out);
