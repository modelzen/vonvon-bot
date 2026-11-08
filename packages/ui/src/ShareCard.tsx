import {useEffect, useMemo, useRef, useState, type Ref} from 'react';
import {SHARE_CARD_WIDTH, type DesktopSnapshot} from '@vonvon/protocol';
import type {ShareCardBridge, ShareLayout} from './client-context';
import {QrCode} from './BadgeContact';
import {NowBotList} from './NowBotList';
import {NowDecisionRow} from './NowActivity';
import {ClaudeUsagePanel, CodexUsagePanel, JevUsagePanel} from './UsagePanels';
import {SHARE_USAGE, shareModelFrom, type ShareModel, type ShareUsage} from './share-model';
import './share-card.css';

declare global {
  interface Window { vonvonShareCard?: ShareCardBridge }
}

/** The desktop's offscreen window opens the UI at this address (now-share N5b). */
export const SHARE_CARD_HASH = '#share-card';
export const isShareCardRoute = (hash: string) => hash === SHARE_CARD_HASH;

/** The usage builds day by day after a short pause, easing out; before the clock starts it shows its end. */
const BUILD_DELAY = 150, BUILD_MS = 1600;
/** All the card plays on its own clock from `ready()`: the build-up. Its badges move only under the recorder's pointer. */
export const SHARE_CARD_ANIMATION_MS = BUILD_DELAY + BUILD_MS;
/** With no quota column the heatmap takes its room, in the app's 13 px cells and 3.5 px gaps: 26 weeks are 425.5 px of
 * the card's 840, leaving the stats 386 px (the app gives them 363 beside its quota column). */
const WIDE_WEEKS = 26;
export function shareProgress(elapsed: number): number {
  const x = Math.min(1, Math.max(0, (elapsed - BUILD_DELAY) / BUILD_MS));
  return 1 - (1 - x) ** 3;
}
/** The card's own clock. The recorder slows requestAnimationFrame and performance.now, so the build slows with it. */
function useShareClock(start: number | undefined): number {
  const [progress, setProgress] = useState(1);
  useEffect(() => {
    if (start === undefined) return;
    let frame = 0;
    const tick = () => {
      const next = shareProgress(performance.now() - start);
      setProgress(next);
      if (next < 1) frame = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, [start]);
  return progress;
}

/** NowBotList reads only these; the rest of a snapshot never reaches the share card. */
const shareSnapshot = (model: ShareModel) => ({
  agents: model.bots, groups: model.groups, memberships: model.memberships, attentionModel: model.attentionModel,
  stale: false, host: {kind: 'connected'},
}) as unknown as DesktopSnapshot;
const usageKey = (usage: ShareUsage) => usage.kind === 'jev' ? 'jev' : usage.id;

/** The 此刻 page as it would be shared: the real badges and usage panels, the title and footer of plan section 2. */
export function ShareCard({model, progress = 1, cardRef}: {model: ShareModel; progress?: number; cardRef?: Ref<HTMLElement>}) {
  const snapshot = useMemo(() => shareSnapshot(model), [model]);
  const weeks = model.sections.quota ? undefined : WIDE_WEEKS;
  return <article className="share-card" style={{width: SHARE_CARD_WIDTH}} ref={cardRef} aria-label="我的 AI 团队">
    <header className="share-card-head">
      <span className="share-card-brand"><img src="./vonvon-logo.png" alt=""/>Vonvon Bot</span>
      <time>{model.date}</time>
    </header>
    <div className="share-card-title">
      <h1>我的 AI 团队</h1>
      <p>{`${model.team.bots} 位 AI 同事${model.team.groups ? ` · 在 ${model.team.groups} 个飞书群上班` : ''}`}</p>
    </div>
    {model.badges && model.bots.length > 0 && <NowBotList share snapshot={snapshot} connected disabled onChangeNumber={async () => undefined}/>}
    {model.usage.map(usage => {
      const kind = SHARE_USAGE.find(item => item.id === usageKey(usage))!;
      return <section className="share-card-usage" key={kind.id} aria-label={`${kind.name} 用量`}>
        <h2><img src={kind.icon} alt="" data-round={kind.round}/>{usage.kind === 'jev' ? 'Jev 判断次数' : `${kind.name} 用量`}</h2>
        {usage.kind === 'jev'
          ? <JevUsagePanel view={usage.view} agents={model.bots} asOf={usage.asOf} progress={progress} sections={model.sections}/>
          : usage.id === 'claude-agent' ? <ClaudeUsagePanel data={usage.data} progress={progress} sections={model.sections} weeks={weeks}/>
          : <CodexUsagePanel data={usage.data} progress={progress} sections={model.sections} weeks={weeks}/>}
      </section>;
    })}
    {model.activity && <section className="share-card-activity" aria-label="群动态">
      <h2>群动态</h2>
      {model.activity.length ? model.activity.map(entry => <NowDecisionRow key={entry.key} entry={entry}/>) : <p className="now-activity-empty">暂时没有新动态</p>}
    </section>}
    <footer className="share-card-foot">
      <div className="share-card-pitch">
        <strong>vonvon.cc</strong>
        <span>给你的<span className="share-card-feishu"><img src="./agent-icons/feishu.png" alt=""/>飞书</span>也招几位 AI 同事</span>
      </div>
      <div className="share-card-scan">
        <p><b>扫码了解 Vonvon Bot</b><span>在电脑上下载使用</span></p>
        <QrCode className="share-card-code" url={model.qrUrl} label="Vonvon Bot 官网二维码" quiet={2}/>
      </div>
    </footer>
  </article>;
}

type Box = {getBoundingClientRect(): {left: number; top: number; width: number; height: number}};
type CardElement = Box & {querySelector(selector: string): (Box & {scrollWidth: number; clientWidth: number}) | null; querySelectorAll(selector: string): ArrayLike<Box>};
/** CSS pixels from the card's top left. Each badge is its turning face, in rail order, those scrolled out included. The
 * recorder plays the card for at least `animationMs`. */
export function shareLayout(card: CardElement): ShareLayout {
  const origin = card.getBoundingClientRect();
  const rect = (box: Box) => {
    const {left, top, width, height} = box.getBoundingClientRect();
    return {x: left - origin.left, y: top - origin.top, width, height};
  };
  const rail = card.querySelector('.badge-rail');
  return {
    width: origin.width, height: origin.height,
    badges: Array.from(card.querySelectorAll('.badge-slot .badge-flipper'), rect),
    rail: rail ? {...rect(rail), scrollWidth: rail.scrollWidth, clientWidth: rail.clientWidth} : {x: 0, y: 0, width: 0, height: 0, scrollWidth: 0, clientWidth: 0},
    animationMs: SHARE_CARD_ANIMATION_MS,
  };
}
/** Fonts loaded, every picture in, and a frame on screen. */
async function painted(card: HTMLElement): Promise<void> {
  await document.fonts.ready;
  await Promise.all(Array.from(card.querySelectorAll('img'), image => image.complete ? undefined
    : new Promise(done => {image.addEventListener('load', done, {once: true}); image.addEventListener('error', done, {once: true});})));
  await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
}
/** The offscreen page's whole life: the model from the bridge, shown, then `ready` with its layout; the card's clock
 * starts when that resolves. It reads nothing else and never talks to a daemon. */
export async function startShareCard(bridge: ShareCardBridge, show: (model: ShareModel) => Promise<CardElement>): Promise<void> {
  const model = shareModelFrom(await bridge.model());
  if (!model) throw new Error('分享卡没有拿到能画的内容。');
  await bridge.ready(shareLayout(await show(model)));
}

/** `#share-card`: only the card, its model from `window.vonvonShareCard`. */
export function ShareCardPage({bridge}: {bridge?: ShareCardBridge}) {
  const [model, setModel] = useState<ShareModel>();
  const [problem, setProblem] = useState('');
  const [start, setStart] = useState<number>();
  const card = useRef<HTMLElement>(null);
  const shown = useRef<(card: HTMLElement) => void>(undefined);
  useEffect(() => {
    if (!bridge) return;
    let active = true;
    startShareCard(bridge, next => new Promise(resolve => {shown.current = resolve; setModel(next);}))
      .then(() => {if (active) setStart(performance.now());}, (error: unknown) => {
        console.error('Share card failed', error);
        if (active) setProblem(error instanceof Error ? error.message : '分享卡没有画好。');
      });
    return () => {active = false;};
  }, [bridge]);
  useEffect(() => {
    const node = card.current;
    if (model && node) void painted(node).then(() => shown.current?.(node));
  }, [model]);
  const progress = useShareClock(start);
  if (!bridge || problem) return <main className="app-connection-state" role="alert"><h1>{problem || '分享卡只在桌面端的录制窗口里打开。'}</h1></main>;
  return model ? <div className="share-card-page"><ShareCard model={model} progress={progress} cardRef={card}/></div> : null;
}
