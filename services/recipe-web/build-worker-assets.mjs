import { cp, copyFile, mkdir } from 'node:fs/promises';

const target = new URL('./dist/worker-assets/', import.meta.url);
const files = [
  ['dist/viewer.mjs', 'recipe-web/dist/viewer.mjs'],
  ['dist/viewer.css', 'recipe-web/dist/viewer.css'],
  ['node_modules/markdown-it/dist/browser/markdown-it.esm.min.mjs',
    'recipe-web/node_modules/markdown-it/dist/browser/markdown-it.esm.min.mjs'],
  ['../recipe-api/src/logo-format.mjs', 'recipe-api/src/logo-format.mjs'],
  ['../recipe-api/src/credential-shapes.mjs', 'recipe-api/src/credential-shapes.mjs'],
];
await cp(new URL('./public/', import.meta.url), new URL('recipe-web/public/', target), {recursive: true});
for (const [source, path] of files) {
  const destination = new URL(path, target);
  await mkdir(new URL('./', destination), {recursive: true});
  await copyFile(new URL(source, import.meta.url), destination);
}
