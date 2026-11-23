// Offline developer export: node --experimental-strip-types scripts/recipes/export-feedback-code.mjs BASELINE RECEIPT LOGO OUT
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, readFile, rename, rm, writeFile, lstat} from 'node:fs/promises';
import {basename, dirname, join, posix, resolve} from 'node:path';
import {feedbackBoardUrl, feedbackFormUrl} from '../feedback/center.mjs';
import {createFeedbackRecipe, feedbackHelpUrls} from '../../packages/daemon/src/feedback/recipe.ts';
import {decodeRichRecipeContent, openResourceSnapshot} from '../../packages/protocol/dist/index.js';
import {document, freezeSnapshot, inventory, writableDocument} from '../../services/recipe-api/src/rich-document.mjs';

const [baselinePath, receiptPath, logoPath, output] = process.argv.slice(2);
if (!output || process.argv.length !== 6) throw Error('Expected: BASELINE.json PUBLICATION-RECEIPT.json LOGO.webp NEW-OUTPUT-DIRECTORY');
const sha = data => createHash('sha256').update(data).digest('hex');
const json = data => JSON.stringify(data, null, 2) + '\n';
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
const [baseline, receipts, logo] = await Promise.all([readJson(baselinePath), readJson(receiptPath), readFile(logoPath)]);
assert.equal(baseline.capturedFromActualAcceptedR2, true);
const base = decodeRichRecipeContent(Buffer.from(baseline.canonical, 'base64url')).content;
const targetReceipt = receipts.filter(r => r.phase === 'committed' && r.result?.kind === 'published' &&
  r.publicVersion === base.public.version.value && r.result.revision === baseline.revision);
assert.equal(targetReceipt.length, 1, 'need exactly one matching published baseline');
const {recipeId, versionId: sourceVersionId} = targetReceipt[0].result.target;
const logoPart = base.parts.find(p => p.kind === 'finalLogo' && p.objectId === base.finalLogo?.objectId);
assert.ok(logoPart, 'expected original logo');
for (const p of base.parts) {
  const bytes = p.kind === 'finalLogo' ? logo : Buffer.from(baseline.texts[p.objectId], 'utf8');
  assert.equal(bytes.length, p.bytes);
  assert.equal(sha(bytes), p.sha256, 'failed baseline part hash: ' + p.objectId);
}
const template = createFeedbackRecipe({boardUrl:feedbackBoardUrl, formUrl:feedbackFormUrl});
const content = structuredClone(base), files = new Map();
assert.equal(template.public.name.value, base.public.name.value);
assert.notEqual(template.public.version.value, base.public.version.value);
// Keep the accepted release identity, rules, skill names and original logo.
for (const field of ['summary', 'overview', 'version']) {
  content.public[field].value = template.public[field].value;
}
content.role.text = template.role.text;
assert.equal(template.skills.length, base.skills.length);
const oldTextParts = new Set();
for (const skill of template.skills) {
  const entry = template.files.find(f => f.itemId === skill.entryFileId);
  const name = /^---\nname: ([a-z][a-z0-9-]+)\n/u.exec(entry.text.value)?.[1];
  const prior = content.skills.find(s => s.name === name);
  assert.ok(prior, 'no matching accepted skill: ' + name);
  const existingFiles = new Set(prior.fileIds);
  const folder = posix.dirname(entry.name);
  for (const id of skill.fileIds) {
    const source = template.files.find(f => f.itemId === id);
    const relative = posix.relative(folder, source.name);
    assert.match(relative, /^(?:[\w-]+\/)*[\w-]+\.md$/u);
    let file = content.files.find(f => prior.fileIds.includes(f.itemId) && f.name === relative && f.use === source.use);
    assert.equal(source.text.kind, 'inline');
    const skillPath = name + '/' + relative;
    if (file) {
      assert.equal(id === skill.entryFileId, file.itemId === prior.entryFileId);
      assert.ok(existingFiles.delete(file.itemId), 'duplicate accepted file: ' + skillPath);
      assert.equal(file.text.kind, 'part');
      oldTextParts.add(file.text.objectId);
      file.text = source.text;
    } else {
      assert.equal(source.use, 'reference', 'only a new skill reference can be appended to R2');
      assert.ok(!content.files.some(item => item.itemId === source.itemId || item.name === relative && prior.fileIds.includes(item.itemId)));
      file = {...source, name:relative};
      prior.fileIds.push(file.itemId);
      content.files.push(file);
    }
    const dest = 'skills/' + skillPath;
    assert.ok(!files.has(dest));
    files.set(dest, file.text.value);
  }
  assert.equal(existingFiles.size, 0, 'an accepted R2 file was lost: ' + name);
}
assert.equal(files.size, template.files.length);
content.parts = content.parts.filter(p => !oldTextParts.has(p.objectId));
writableDocument(content);
const userFacing = [content.role.text.value, ...Object.values(content.public).map(value => value.value), ...files.values()].join('\n');
const officialUrls = new Set(userFacing.match(/https?:\/\/[^\s]+/gu));
assert.deepEqual(officialUrls, new Set([feedbackBoardUrl, feedbackFormUrl, ...Object.values(feedbackHelpUrls)]), 'recipe must contain only the approved public URLs');
assert.doesNotMatch(userFacing, /(?:oc|ou|on|om)_[a-zA-Z0-9]{8,}|Bearer\s+\S+|(?:appSecret|access_token|refresh_token)\s*[:=]\s*\S+|\/(?:Users|home)\/[a-zA-Z0-9._-]+/u);
const prior = new Map(inventory(base).map(row => [row.itemId, row]));
const origins = inventory(content).map(({itemId}) => ({itemId, source: prior.has(itemId) ? {
  kind: 'releaseItem', versionId: sourceVersionId, itemId, baselineSha256: prior.get(itemId).baselineSha256,
} : {kind: 'accountClaim'}}));
const source = {format:'rich-v2', access: baseline.public.access, sourceVersionId, content, origins};
// Only a real approval supplies a production allocation seed and upload-package ID.
// This reproducible local preview uses its own namespace, never an upstream release identity.
const seed = Buffer.from(sha('vonvon-feedback-local-preview:' + sourceVersionId), 'hex');
const frozen = freezeSnapshot(source, seed, prior);
const doc = document(frozen.content, true), contentSha256 = sha(doc.canonicalUTF8);
for (const id of prior.keys()) {
  assert.equal(inventory(doc.content).find(r => r.itemId === id)?.originId, prior.get(id).originId, 'lost baseline identity: ' + id);
}
const localId = tag => {
  const h = sha('local-preview:' + tag);
  return h.slice(0,8) + '-' + h.slice(8,12) + '-4' + h.slice(13,16) + '-8' + h.slice(17,20) + '-' + h.slice(20,32);
};
const target = {recipeId, versionId:localId(contentSha256)}, revision = baseline.revision + 1;
const release = {format:'rich-v2', ...target, revision, authorId:localId('author'), access:source.access, contentSha256, logicalBytes:doc.logicalBytes};
const publicFields = Object.fromEntries(Object.entries(doc.content.public).map(([k,v]) => [k,v.value]));
const preview = {format:'rich-v2', target, revision, public:{...publicFields, access:source.access}, contentSha256, release,
  canonical:Buffer.from(doc.canonicalUTF8).toString('base64url'), members:{[logoPart.objectId]:logo.toString('base64url')}};
const resources = await openResourceSnapshot(preview);
const entries = resources.readPage({kind:'index'}).entries;
assert.equal(entries.filter(e => e.kind === 'skill').length, template.skills.length);
for (const entry of entries.filter(e => e.kind === 'file')) {
  let body = '', cursor;
  do {
    const page = resources.readPage({kind:'text', documentId:entry.documentId, ...(cursor ? {cursor} : {})});
    body += page.text; cursor = page.nextCursor;
  } while (cursor);
  assert.ok([...files.values()].includes(body));
}
files.set('source.json',json(source));
files.set('developer-preview.json',json(preview));
files.set('logo.webp',logo);
files.set('role.md',content.role.text.value + '\n');
files.set('README.md',[
  '# Vonvon 帮助与反馈 · ' + publicFields.version, '',
  'developer-preview.json 是自包含的本地开发者预览，可交给 @vonvon/protocol 的 openResourceSnapshot()。它包含真实 Skill、角色、官网入门摘录、摘要参考文件和原图；本地分配的预览版本号和作者 ID 不代表服务端发布回执。', '',
  'source.json 是更新既有 R2 的 rich-v2 草稿源数据；skills/ 是对应技能的可读源码。官方 Setup 附带公开的看板和提交表单链接；群绑定和个人授权由使用者在自己的宿主上完成。', '',
  '通过原作者的正常开发者流程从 R2 建立更新草稿。如果使用 API 录入 source.json，应先在本次 intent/会话使用 logo.webp 完成图片上传，用服务提交附件后返回的 Logo 描述替换 content.parts 中的旧描述，并将 content.finalLogo.objectId 指向新描述的 objectId（保留原 itemId/originId）。用本次 packageId 和原图输入 SHA-256 填入 logoUpload；确认草稿后才可发布和领取。不能将开发者预览文件当作领取码、发布凭据或双击安装包。','',
  '来源 recipeId: ' + recipeId, '来源 R2 versionId: ' + sourceVersionId, '本地预览内容 SHA-256: ' + contentSha256, '',
].join('\n'));
// Stage beside destination. A changed previous export is never overwritten.
const out = resolve(output);
await mkdir(dirname(out),{recursive:true});
const exists = await lstat(out).catch(e => {if (e.code !== 'ENOENT') throw e;});
if (exists) {
  assert.ok(exists.isDirectory(), 'output already exists');
  for (const [name, data] of files) assert.deepEqual(await readFile(join(out,name)),Buffer.from(data), 'output differs: ' + name + '; choose a new directory');
} else {
  const stage = await mkdtemp(join(dirname(out),'.' + basename(out) + '-'));
  try {
    for (const [name, data] of files) {
      await mkdir(dirname(join(stage,name)),{recursive:true}); await writeFile(join(stage,name),data,{mode:0o600});
    }
    await rename(stage,out);
  } finally { await rm(stage,{recursive:true,force:true}); }
}
console.log(json({output:out,version:publicFields.version,recipeId,sourceVersionId,contentSha256,files:files.size,baselineItemsPreserved:prior.size}));
