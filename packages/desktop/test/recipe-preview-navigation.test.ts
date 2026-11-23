import { getConfig } from 'app-builder-lib/out/util/config/config.js';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { captureRecipePreviewLaunches, parseDraftPreview, RecipePreviewNavigation } from '../src/recipe-preview-navigation.js';
const draftId = '8d85af21-e80d-4665-a6b8-ccf162dc1923';
const link = `vonvon-preview://recipes/drafts/${draftId}?revision=2`;

describe('draft preview navigation', () => {
  it('uses the same retained locator queue for native callbacks and strict URL launches', () => {
    const nav = new RecipePreviewNavigation('vonvon-preview'), show = vi.fn();
    nav.onOpen(show);
    nav.request({draftId, revision: 2});
    expect(show).toHaveBeenCalledOnce();
    expect(nav.open(link)).toBe(true);
    expect(nav.pending()).toHaveLength(1);
    expect(show).toHaveBeenCalledTimes(2);
    nav.acknowledge(nav.pending()[0].navigationId);
    nav.request({draftId, revision: 2});
    expect(show).toHaveBeenCalledTimes(3);
    expect(() => nav.request({draftId, revision: 0})).toThrow();
    expect(() => nav.request(Object.assign({draftId, revision: 2}, {publish: true}))).toThrow();
  });

  it('wires native preview opens to the existing window and Dock restore path', () => {
    const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
    expect(main).toContain('recipePreview.onOpen(show)');
    const show = main.slice(main.indexOf('const show ='), main.indexOf('const show =') + 2400);
    expect(show).toContain('current.show()');
    expect(show).toContain('current.focus()');
    expect(show).toContain('app.dock.show()');
    const bridge = readFileSync(new URL('../src/bridge.ts', import.meta.url), 'utf8');
    expect(bridge).toContain("current.kind!=='signedIn'||current.accountId!==value.accountId");
    expect(bridge).toContain('recipePreview.request({draftId:value.draftId,revision:value.revision},value.accountId)');
  });
  it('resolved packager configuration isolates preview and stable protocol handlers', async () => {
    const project = fileURLToPath(new URL('../', import.meta.url));
    const stable = await getConfig(project, 'electron-builder.yml', undefined);
    const preview = await getConfig(project, 'electron-builder.preview.yml', undefined);
    const universal = await getConfig(project, 'electron-builder-universal.yml', undefined);
    expect(stable.protocols).toEqual([{name: 'Vonvon draft preview', schemes: ['vonvon']}]);
    expect(preview.protocols).toEqual({name: 'Vonvon draft preview', schemes: ['vonvon-preview']});
    expect(preview.appId).toBe('com.vonvon.bot.preview');
    expect(universal.protocols).toEqual(stable.protocols);
  });
  it('accepts only this build channel and an exact locator', () => {
    expect(parseDraftPreview(link, 'vonvon-preview')).toEqual({draftId, revision: 2});
    expect(parseDraftPreview(link.replace('vonvon-preview:', 'vonvon:'), 'vonvon')).toEqual({draftId, revision: 2});
    for (const raw of [link.replace('vonvon-preview:', 'vonvon:'), link + '#x', link + '&publish=true', link + '&revision=3',
      link.replace('revision=2', 'revision=0'), link.replace('revision=2', 'revision=02'), link.replace('revision=2', 'revision=1e2'),
      link.replace('revision=2', 'revision=9007199254740992'), link.replace('recipes/', 'user@recipes/'),
      link.replace('recipes/', 'recipes:123/'), link.replace('/drafts/', '/%64rafts/'), link.replace('?revision=2', ''),
      link.replace('recipes/', 'recipes/../recipes/'), link.replace('vonvon-preview:', 'VONVON-PREVIEW:'), ' ' + link,
      link + '\n', undefined]) {
      expect(parseDraftPreview(raw, 'vonvon-preview'), String(raw)).toBeUndefined();
    }
  });

  it('retains unread locators across renderer reload and login until exact acknowledgement', () => {
    const nav = new RecipePreviewNavigation('vonvon-preview');
    expect(nav.open(link)).toBe(true);
    const first = nav.pending()[0];
    expect(first).toMatchObject({draftId, revision: 2});
    const listener = vi.fn();
    const off = nav.onOpen(listener);
    expect(nav.open(link)).toBe(true);
    expect(nav.pending()).toEqual([first]);
    expect(listener).toHaveBeenCalledExactlyOnceWith(first);
    nav.open(link.replace('revision=2', 'revision=3'));
    expect(listener).toHaveBeenCalledTimes(2);
    off();
    const pending = nav.pending();
    const copy = pending[0];
    if ('kind' in copy) throw new Error('Expected draft navigation');
    copy.revision = 99;
    expect(nav.pending()[0]).toMatchObject({revision:2});
    nav.acknowledge('11111111-1111-4111-8111-111111111111');
    expect(nav.pending()).toHaveLength(2);
    nav.acknowledge(first.navigationId);
    expect(nav.pending()).toEqual([expect.objectContaining({revision: 3})]);
    expect(() => nav.acknowledge('invalid')).toThrow();
  });

  it('captures Mac cold open-url and Windows cold argv and warm second-instance before readiness', () => {
    const nav = new RecipePreviewNavigation('vonvon-preview');
    let open: (event: {preventDefault(): void}, url: string) => void = () => {};
    let second: (argv: string[]) => void = () => {};
    const reveal = vi.fn();
    captureRecipePreviewLaunches(nav, {
      onOpenUrl(listener) { open = listener; },
      onSecondInstance(listener) { second = listener; },
      argv: ['app.exe', link], reveal,
    });
    expect(nav.pending()).toHaveLength(1);
    const event = {preventDefault: vi.fn()};
    open(event, link.replace('revision=2', 'revision=3'));
    expect(event.preventDefault).toHaveBeenCalledOnce();
    second(['app.exe', '--ignored', link.replace('revision=2', 'revision=4')]);
    expect(nav.pending().map(value => 'revision' in value ? value.revision : undefined)).toEqual([2, 3, 4]);
    expect(reveal).toHaveBeenCalledTimes(3);
    open(event, 'vonvon://recipes/drafts/' + draftId + '?revision=5');
    expect(nav.pending()).toHaveLength(3);
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });
});

it('keeps authenticated callbacks separate from URL launches and cancels them on account switch',()=>{
  const nav=new RecipePreviewNavigation('vonvon-preview'),owner='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
  nav.request({draftId,revision:2},owner);
  nav.open(link);
  const [bound,external]=nav.pending();
  expect(bound).toMatchObject({accountId:owner});expect('accountId' in external ? external.accountId : undefined).toBeUndefined();
  nav.acknowledge(bound.navigationId,other);expect(nav.pending()).toHaveLength(2);
  nav.retainAccount(other);expect(nav.pending()).toEqual([external]);
});

it('launches creation only for the exact active channel, retaining and acknowledging the inert navigation', () => {
  for (const scheme of ['vonvon','vonvon-preview'] as const) {
    const nav = new RecipePreviewNavigation(scheme), listener = vi.fn();
    nav.onOpen(listener);
    const create = `${scheme}://recipes/create`;
    expect(nav.open(create)).toBe(true);
    const first = nav.pending()[0];
    expect(first).toEqual({kind:'create',navigationId:expect.any(String)});
    expect(nav.open(create)).toBe(true);
    expect(nav.pending()).toEqual([first]);
    expect(listener).toHaveBeenCalledTimes(2);
    for (const invalid of [create+'/',create+'?source=bot',create+'?',create+'#',create+'#publish',create+'\n',' '+create,create.replace('recipes/','user@recipes/'),create.replace('/create','/%63reate'),create.replace(scheme,scheme==='vonvon'?'vonvon-preview':'vonvon')]) {
      expect(nav.open(invalid), invalid).toBe(false);
    }
    nav.acknowledge(first.navigationId);
    expect(nav.pending()).toEqual([]);
    expect(nav.open(create)).toBe(true);
    expect(nav.pending()[0].navigationId).not.toBe(first.navigationId);
  }
});
it('captures creation through cold startup and warm URL launch using the existing reveal path', () => {
  const nav = new RecipePreviewNavigation('vonvon-preview'), reveal = vi.fn();
  let open: (event:{preventDefault():void},url:string)=>void = () => {};
  let second:(argv:string[])=>void = () => {};
  captureRecipePreviewLaunches(nav,{onOpenUrl:listener=>{open=listener;},onSecondInstance:listener=>{second=listener;},argv:['app','vonvon-preview://recipes/create'],reveal});
  expect(nav.pending()[0]).toMatchObject({kind:'create'});
  const event={preventDefault:vi.fn()};
  open(event,'vonvon-preview://recipes/create');
  second(['app','vonvon-preview://recipes/create']);
  expect(event.preventDefault).toHaveBeenCalledOnce();
  expect(reveal).toHaveBeenCalledTimes(3);
});
