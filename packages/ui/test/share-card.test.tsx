import {readFileSync} from 'node:fs';
import {expect, it, vi} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import type {DesktopSnapshot} from '@vonvon/protocol';
import type {ShareCardBridge, ShareLayout} from '../src/client-context';
import type {Usage} from '../src/management/usage-data';
import type {NowProvider} from '../src/NowUsage';
import {isShareCardRoute, SHARE_CARD_ANIMATION_MS, ShareCard, ShareCardPage, shareLayout, shareProgress, startShareCard} from '../src/ShareCard';
import {buildShareModel, defaultShareOptions, type ShareModel} from '../src/share-model';

const snapshot = {
  attentionModel: 'group', revision: 1, observedAt: 1, stale: false, host: {kind: 'connected', ownership: 'owned', version: 'test'},
  agents: [], groups: [], memberships: [], tools: [], jobs: [], application: {platform: 'macos', version: 'test', loginItem: false, dataPath: '/test'},
} as unknown as DesktopSnapshot;
const model = buildShareModel({snapshot, providers: [], now: 1}, defaultShareOptions([], 1));
const box = (left: number, top: number, width: number, height: number) => ({getBoundingClientRect: () => ({left, top, width, height})});
function card(withRail = true) {
  const rail = {...box(100, 300, 904, 354), scrollWidth: 1702, clientWidth: 904};
  const badges = [box(162, 360, 320, 500), box(500, 370, 320, 500)];
  const selectors: string[] = [];
  return {
    selectors,
    element: {
      ...box(100, 50, 904, 1050),
      querySelector: (selector: string) => {selectors.push(selector); return withRail ? rail : null;},
      querySelectorAll: (selector: string) => {selectors.push(selector); return withRail ? badges : [];},
    },
  };
}

it('opens only at #share-card', () => {
  expect(isShareCardRoute('#share-card')).toBe(true);
  expect(isShareCardRoute('')).toBe(false);
  expect(isShareCardRoute('#share-card/x')).toBe(false);
});

it('builds the usage after a short pause, easing out, and holds the end', () => {
  expect(shareProgress(0)).toBe(0);
  expect(shareProgress(150)).toBe(0);
  const mid = shareProgress(950);
  expect(mid).toBeGreaterThan(0.5);
  expect(mid).toBeLessThan(1);
  expect(shareProgress(1750)).toBe(1);
  expect(shareProgress(60_000)).toBe(1);
  // What the card tells the recorder is the whole of it, no more.
  expect(SHARE_CARD_ANIMATION_MS).toBe(1750);
  expect(shareProgress(SHARE_CARD_ANIMATION_MS - 20)).toBeLessThan(1);
});

it('lays out the badges in rail order and the rail in CSS pixels from the card’s top left', () => {
  const {element, selectors} = card();
  expect(shareLayout(element)).toEqual({
    width: 904, height: 1050,
    badges: [{x: 62, y: 310, width: 320, height: 500}, {x: 400, y: 320, width: 320, height: 500}],
    rail: {x: 0, y: 250, width: 904, height: 354, scrollWidth: 1702, clientWidth: 904},
    animationMs: SHARE_CARD_ANIMATION_MS,
  } satisfies ShareLayout);
  expect(selectors).toEqual(['.badge-rail', '.badge-slot .badge-flipper']);
  expect(shareLayout(card(false).element)).toMatchObject({badges: [], rail: {width: 0, scrollWidth: 0, clientWidth: 0}});
});

it('reads only the bridge: the model in, the layout out once the card is shown', async () => {
  const touched: PropertyKey[] = [];
  const ready = vi.fn(async (_layout: ShareLayout) => undefined);
  const target: ShareCardBridge = {model: async () => JSON.parse(JSON.stringify(model)), ready};
  const bridge = new Proxy(target, {get: (object, key) => {touched.push(key); return Reflect.get(object, key);}});
  const shown: ShareModel[] = [];
  await startShareCard(bridge, async next => {shown.push(next); return card().element;});
  expect(shown).toEqual([JSON.parse(JSON.stringify(model))]);
  expect(ready).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({width: 904, height: 1050, animationMs: 1750}));
  expect(touched).toEqual(['model', 'ready']);
});

it('draws nothing from a model it cannot read and never says ready', async () => {
  const ready = vi.fn(async () => undefined), show = vi.fn();
  await expect(startShareCard({model: async () => ({version: 0}), ready}, show)).rejects.toThrow('分享卡没有拿到能画的内容。');
  expect(show).not.toHaveBeenCalled();
  expect(ready).not.toHaveBeenCalled();
});

it('grows the 13 weeks into a hidden quota column\'s room on the card only, and lays out as the app does when it shows', () => {
  const data = {profile: {topInvocations: [], dailyBuckets: [{date: '2026-11-01', tokens: 100}]}, usage: {main: {}, extras: [], fetchedAt: 1}} as unknown as Usage;
  const provider = {id: 'codex-appserver', name: 'Codex', account: {kind: 'subscription'}, data} as NowProvider;
  const jev = {view: {kind: 'judgeUsage', days: [{date: '2026-11-08', total: 3, sources: [], bots: []}], unreadBots: 0} as const};
  const options = {...defaultShareOptions([provider], 1), usage: ['codex-appserver' as const, 'jev' as const]};
  const html = (quota: boolean) => renderToStaticMarkup(<ShareCard model={buildShareModel({snapshot, providers: [provider], jev, now: 1}, {...options, quota})}/>);
  const cells = (markup: string) => markup.match(/data-future=/g)?.length ?? 0;
  const wide = html(false), app = html(true);
  expect(wide).toContain('style="width:904px"');
  expect(wide).not.toContain('usage-board-quota');
  // Codex's section only: Jev's right column is its Bots, there either way.
  expect(wide.match(/data-wide-heat="true"/g)).toHaveLength(1);
  expect(wide).toMatch(/aria-label="Codex 用量" data-wide-heat="true"/);
  expect(app).toContain('usage-board-quota');
  expect(app).not.toContain('data-wide-heat');
  // The app's 13 weeks either way; only the card's CSS makes them bigger.
  for (const markup of [wide, app]) {
    expect(cells(markup)).toBe(13 * 7);
    expect(markup).toContain('每日 Token · 最近 13 周');
  }
  const css = readFileSync(new URL('../src/share-card.css', import.meta.url), 'utf8');
  expect(css).toContain('.share-card-usage[data-wide-heat] .usage-heatmap__grid {grid-template-rows: repeat(7, 22px); grid-auto-columns: 22px; gap: 4.5px}');
});

it('says where the card opens when there is no bridge', () => {
  expect(renderToStaticMarkup(<ShareCardPage/>)).toContain('分享卡只在桌面端的录制窗口里打开。');
  expect(renderToStaticMarkup(<ShareCardPage bridge={{model: async () => model, ready: async () => undefined}}/>)).toBe('');
});
