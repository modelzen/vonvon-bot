import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
import {
  canonicalizeRichRecipeContent, decodeRichRecipeContent, digestRichRecipeContent, verifyRichRecipeRelease,
  validatePublishableRichRecipeContent, recipeRichAuthoringPayloadSchema, RecipeRichValidationError,
  projectEditableSchemas, type RecipeRichContent,
} from '../src/index.js';

const id = (n: number) => `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const identity = (n: number) => ({itemId: id(n), originId: id(n + 10000)});
const inline = (value: string) => ({kind: 'inline' as const, value});
const fixture = JSON.parse(readFileSync(new URL('./fixtures/recipe-rich-v2.content.json', import.meta.url), 'utf8')) as RecipeRichContent;
const fresh = () => structuredClone(fixture);
const edit = {format: 'rich-v2', purpose: 'editDraft', draftId: id(1), baseRevision: 2, requestId: id(2), schemaVersion: 2};
const setting = (field: string, value: unknown) => ({...fresh(), settings: [{...identity(100), field, value}]});
const task = () => ({...identity(110), name: 'Summary', instruction: inline('Write a summary'),
  spec: {kind: 'daily' as const, time: '09:00'}, timeZone: {kind: 'targetChoice' as const}, placement: 'follow' as const});
function files(names: string[]) {
  const value = fresh();
  value.files = names.map((name, index) => ({...identity(200 + index), name, use: index ? 'reference' : 'skillDescription', text: inline('Text')}));
  value.skills = [{...identity(300), name: 'Notes', entryFileId: id(200), fileIds: value.files.map(file => file.itemId)}];
  return value;
}

describe('rich-v2 independent review regressions', () => {
  it('accepts revision-bound stable-key edit commands instead of replacement snapshots', () => {
    const changes = [{op: 'setPublicText', itemId: fixture.public.name.itemId, field: 'name', value: 'New name'}];
    expect(recipeRichAuthoringPayloadSchema.safeParse({...edit, changes}).success).toBe(true);
    expect(recipeRichAuthoringPayloadSchema.safeParse({...edit, content: fresh()}).success).toBe(false);
    for (const change of [{...changes[0], originId: id(9)}, {...changes[0], newItemId: id(9)}, {...changes[0], parents: []},
      {op: 'replaceContent', content: fresh()}, {op: 'setPath', path: '/role', value: 'Text'}]) {
      expect(recipeRichAuthoringPayloadSchema.safeParse({...edit, changes: [change]}).success).toBe(false);
    }
    for (const patch of [{requestId: undefined}, {schemaVersion: 1}, {changes: []}, {changes: Array(17).fill(changes[0])}]) {
      expect(recipeRichAuthoringPayloadSchema.safeParse({...edit, changes, ...patch}).success).toBe(false);
    }
  });
  it.each(['toString', 'valueOf'])('uses global efforts for an absent own model-map key %s', model => {
    const value = setting('modelAccess.recommendation', {backend: 'codex-appserver', models: [model], efforts: ['high'],
      defaultModel: model, defaultEffort: 'high', modelEfforts: {}});
    const encoded = canonicalizeRichRecipeContent(value);
    expect(decodeRichRecipeContent(encoded.canonicalUTF8).content).toEqual(encoded.content);
    expect(() => canonicalizeRichRecipeContent(setting('modelAccess.recommendation', {backend: 'codex-appserver', models: [model],
      efforts: ['high'], defaultModel: model, defaultEffort: 'missing', modelEfforts: {}}))).toThrow(RecipeRichValidationError);
  });
  it.each([
    ['SKILL.md', 'archive.txt', 'archive.txt/ref.md'],
    ['SKILL.md', 'Archive.txt', 'archive.txt/ref.md'],
    ['SKILL.md', 'οσ.txt', 'ος.txt'],
    ['SKILL.md', 'Straße.txt', 'STRASSE.txt'],
    ['SKILL.md', 'COM¹.txt'], ['SKILL.md', 'LPT².txt'], ['SKILL.md', 'COM³.txt'],
  ])('rejects an irreconcilable portable skill tree %j', (...names) => {
    expect(() => validatePublishableRichRecipeContent(files(names))).toThrow();
  });
  it('preserves legitimate Chinese and Unicode filenames in a portable skill tree', () => {
    expect(() => validatePublishableRichRecipeContent(files(['SKILL.md', '参考/使用说明.md', 'résumé.txt', '資料/😀.rst']))).not.toThrow();
  });
  it.each(['60 24 32 13 8', '*/0 * * * *', '5/2 * * * *', '30-10 * * * *'])('rejects native-invalid cron %s', expr => {
    expect(() => validatePublishableRichRecipeContent({...fresh(), tasks: [{...task(), spec: {kind: 'cron', expr}}]})).toThrow();
  });
  it('rejects a nonexistent recommended timezone', () => {
    expect(() => validatePublishableRichRecipeContent({...fresh(), tasks: [{...task(), timeZone: {kind: 'recommended', iana: 'Never/Here'}}]})).toThrow();
  });
  it('allows incomplete task text in a private draft but requires usable selected task text to publish', () => {
    for (const patch of [{name: ''}, {name: ' \t '}, {instruction: inline('')}, {instruction: inline(' \n ')}]) {
      const value = {...fresh(), tasks: [{...task(), ...patch}]};
      expect(() => canonicalizeRichRecipeContent(value)).not.toThrow();
      expect(() => validatePublishableRichRecipeContent(value)).toThrow();
    }
    const value = fresh();
    value.tasks = [{...task(), instruction: {kind: 'part', objectId: value.parts[0]!.objectId}}];
    value.parts[0]!.bytes = 0;
    expect(() => canonicalizeRichRecipeContent(value)).not.toThrow();
    expect(() => validatePublishableRichRecipeContent(value)).toThrow();
  });
  it.each(['llm', 'decision'] as const)('uses the native %s judge identifier bound', kind => {
    const selection = (length: number) => kind === 'llm' ? {kind, backend: 'x'.repeat(length), model: 'model'} : {kind, provider: 'x'.repeat(length), model: 'model'};
    expect(projectEditableSchemas.judge.safeParse({selection: selection(100)}).success).toBe(true);
    expect(() => validatePublishableRichRecipeContent(setting('judge.recommendation', selection(100)))).not.toThrow();
    expect(projectEditableSchemas.judge.safeParse({selection: selection(101)}).success).toBe(false);
    expect(() => validatePublishableRichRecipeContent(setting('judge.recommendation', selection(101)))).toThrow();
  });
  it('rejects a Codex full-access requirement that implies network off', () => {
    expect(() => validatePublishableRichRecipeContent(setting('permission.codex.requirement', {sandbox: 'danger-full-access', network: false}))).toThrow();
    for (const sandbox of ['read-only', 'workspace-write']) {
      expect(() => validatePublishableRichRecipeContent(setting('permission.codex.requirement', {sandbox, network: false}))).not.toThrow();
    }
    expect(() => validatePublishableRichRecipeContent(setting('permission.codex.requirement', {sandbox: 'danger-full-access', network: true}))).not.toThrow();
  });
  it('rejects array accessors without invoking them', () => {
    const value = fresh();
    let calls = 0;
    Object.defineProperty(value.memories, 0, {get() {calls++; return fixture.memories[0];}, enumerable: true});
    expect(() => canonicalizeRichRecipeContent(value)).toThrow(RecipeRichValidationError);
    expect(calls).toBe(0);
  });
  it('rejects holes, extra array keys, custom iterators and array subclasses', () => {
    for (const alter of [
      (array: unknown[]) => {Object.defineProperty(array, 'extra', {value: 1, enumerable: true});},
      (array: unknown[]) => {Object.defineProperty(array, Symbol('extra'), {value: 1});},
      (array: unknown[]) => {Object.defineProperty(array, Symbol.iterator, {get() {throw new Error('iterator executed');}});},
      (array: unknown[]) => {array.length = 1;},
      (array: unknown[]) => {Object.setPrototypeOf(array, Object.create(Array.prototype));},
    ]) {
      const value = fresh();
      alter(value.rules);
      expect(() => canonicalizeRichRecipeContent(value)).toThrow(RecipeRichValidationError);
    }
  });
  it('preflights the release envelope before schema parsing without executing accessors', async () => {
    const encoded = canonicalizeRichRecipeContent(fresh());
    const envelope = {format: 'rich-v2', recipeId: id(600), versionId: id(601), authorId: id(602), revision: 1,
      access: 'direct', contentSha256: await digestRichRecipeContent(encoded), logicalBytes: encoded.logicalBytes};
    await expect(verifyRichRecipeRelease(envelope, encoded.canonicalUTF8)).resolves.toMatchObject({canonical: encoded.canonical});
    let calls = 0;
    Object.defineProperty(envelope, 'contentSha256', {get() {calls++; return 'a'.repeat(64);}, enumerable: true});
    await expect(verifyRichRecipeRelease(envelope, encoded.canonicalUTF8)).rejects.toBeInstanceOf(RecipeRichValidationError);
    expect(calls).toBe(0);
  });
});
