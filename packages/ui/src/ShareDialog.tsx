import {useEffect, useMemo, useRef, useState, type ReactNode} from 'react';
import type {DesktopSnapshot} from '@vonvon/protocol';
import {Button, SelectControl, Toggle} from './reference/components/ui';
import {Dialog} from './reference/components/ui/Dialog';
import {SettingsGroup, SettingsRow} from './reference/components/system-settings';
import {ClientProvider, LOCAL_ACTIVE_DEVICE, useActiveDevice, useClient, useDevicesState, useShellCapabilities, type ShareRecording, type ShareShell} from './client-context';
import {desktopPlatformMark} from './devices/devices-presentation';
import {useJudgeUsage} from './management/JudgeUsage';
import {badgeUrl} from './BadgeContact';
import {openExternalUrl} from './url-actions';
import type {NowProvider} from './NowUsage';
import {ShareCard} from './ShareCard';
import {buildShareModel, defaultShareOptions, SHARE_USAGE, shareable, type ShareOptions, type ShareUsageId} from './share-model';
import {
  lastShareChoice, readShareTargets, recipientName, rememberShareChoice, SHARE_OLD_DAEMON, shareChoice, shareErrorText,
  shareRecordings, shareSenders, sendShareGif, sharesGif, type ShareChoice, type ShareRecipient, type ShareTargetsRead,
} from './share-send';
import './management/usage.css';
import './settings/settings.css';
import './share-dialog.css';

/** The GIF is a file on this computer, whichever device is shown. */
export const revealLabel = (platform: string | undefined) => platform === 'windows' ? '在资源管理器中显示' : platform === 'linux' ? '在文件夹中显示' : '在访达中显示';
/** Why 发到飞书 cannot be used, if it cannot. */
export function sendBlocked(targets: ShareTargetsRead): string | undefined {
  if (targets.kind === 'loading') return '正在读取能发图的 Bot…';
  if (targets.kind === 'old') return SHARE_OLD_DAEMON;
  if (targets.kind === 'failed') return `读不到能发图的 Bot：${targets.message}`;
  if (!shareSenders(targets.bots).length) return targets.bots.some(bot => bot.recipients.length)
    ? '有管理员的 Bot 都没连上，连上后才能私聊发图。' : '还没有 Bot 设置管理员，图只能私聊发给管理员。';
  return undefined;
}

type Toast = {kind: 'copied'; path: string} | {kind: 'sent'; bot: string; name: string; url?: string} | {kind: 'error'; message: string};
type Work = {action: 'copy' | 'send'; label: string};
const switches: {key: Exclude<keyof ShareOptions, 'usage'>; group: '显示' | '打码'; title: string; hint?: string}[] = [
  {key: 'badges', group: '显示', title: '工牌', hint: '依次翻面'},
  {key: 'habits', group: '显示', title: '使用习惯', hint: '技能、推理强度、模型'},
  {key: 'quota', group: '显示', title: '额度和套餐'},
  {key: 'activity', group: '显示', title: '群动态', hint: '最近 3 条回复'},
  {key: 'maskGroups', group: '打码', title: '群名称', hint: '工牌背面、群动态'},
  {key: 'maskPeople', group: '打码', title: '人名', hint: '直属上级、账号名'},
];

/** now-share N5a: options on the right of a live card, 复制 and 发到飞书 below; only on the desktop, which records. */
export function ShareDialog({share, snapshot, providers, onClose}: {share: ShareShell; snapshot: DesktopSnapshot; providers: readonly NowProvider[]; onClose: () => void}) {
  const client = useClient();
  const shell = useShellCapabilities();
  const device = useActiveDevice();
  const platform = desktopPlatformMark(useDevicesState()) ?? (device.isRemote ? undefined : snapshot.application.platform);
  const {read: judge, readAt} = useJudgeUsage();
  const [openedAt] = useState(() => Date.now());
  const [changed, setChanged] = useState<Partial<ShareOptions>>({});
  const options: ShareOptions = {...defaultShareOptions(providers, openedAt), ...changed};
  const key = JSON.stringify(options);
  const jev = useMemo(() => judge.kind === 'ready' ? {view: judge.view, asOf: readAt} : undefined, [judge, readAt]);
  const model = useMemo(() => buildShareModel({snapshot, providers, jev, now: openedAt}, options), [snapshot, providers, jev, openedAt, key]);
  const [targets, setTargets] = useState<ShareTargetsRead>({kind: 'loading'});
  const [last, setLast] = useState<ShareChoice | undefined>(() => lastShareChoice(localStorage, device.id));
  const [work, setWork] = useState<Work>();
  const [toast, setToast] = useState<Toast>();
  const recordings = useMemo(() => shareRecordings(share), [share]);
  const live = useRef({key, closed: false});
  live.current.key = key;
  // Read again only when the device shown starts or stops saying it can, not on each new list.
  const capabilities = device.capabilities, sends = sharesGif(capabilities);
  useEffect(() => {
    let active = true;
    void readShareTargets(request => client.admin(request), capabilities).then(read => {if (active) setTargets(read);});
    return () => {active = false;};
  }, [client, sends]);
  // Other options make another GIF; closing leaves none behind.
  useEffect(() => {recordings.drop(); setToast(undefined);}, [key, recordings]);
  useEffect(() => {
    live.current.closed = false;
    return () => {live.current.closed = true; recordings.close();};
  }, [recordings]);
  const blocked = sendBlocked(targets);
  const chosen = targets.kind === 'ready' ? shareChoice(targets.bots, last) : undefined;
  function choose(next: ShareChoice) {setLast(next); rememberShareChoice(localStorage, device.id, next);}

  /** The recording of what is shown; none once the dialog closed or it was dropped, which discards it. */
  async function record(action: Work['action']): Promise<ShareRecording | undefined> {
    const asked = key;
    // What is shown is kept: defaults no longer follow a usage reply that comes later.
    setChanged(options);
    if (!recordings.has(asked)) setWork({action, label: '正在生成…'});
    const pending = recordings.get(asked, () => model, fraction => {
      if (live.current.key === asked) setWork({action, label: `正在生成 ${Math.round(fraction * 100)}%`});
    });
    const recording = await pending;
    return live.current.closed || !recordings.holds(pending) ? undefined : recording;
  }
  async function copy() {
    setToast(undefined);
    try {
      const recording = await record('copy');
      if (!recording) return;
      setWork({action: 'copy', label: '正在复制…'});
      const {path} = await share.copy(recording.id);
      setToast({kind: 'copied', path});
    } catch (error) {
      setToast({kind: 'error', message: shareErrorText(error, '复制没有完成，请重试。')});
    } finally {setWork(undefined);}
  }
  async function send() {
    if (!chosen) return;
    const {bot, recipient} = chosen, choice = {agentId: bot.agentId, openId: recipient.openId};
    setToast(undefined);
    try {
      const recording = await record('send');
      if (!recording) return;
      setWork({action: 'send', label: '正在发送…'});
      const gif = await share.bytes(recording.id);
      await sendShareGif(request => {
        if (live.current.closed) throw new Error('分享框已关闭。');
        return client.admin(request);
      }, gif, recording, choice, (sent, total) => setWork({action: 'send', label: `正在发送 ${Math.round(sent / total * 100)}%`}));
      choose(choice);
      const agent = snapshot.agents.find(item => item.id === bot.agentId);
      setToast({kind: 'sent', bot: bot.name, name: recipientName(recipient), url: badgeUrl(bot.agentId, agent?.tenant) ?? undefined});
    } catch (error) {
      setToast({kind: 'error', message: shareErrorText(error, '发送没有完成，请重试。')});
    } finally {setWork(undefined);}
  }
  const set = (change: Partial<ShareOptions>) => setChanged(previous => ({...previous, ...change}));
  const toggle = (id: ShareUsageId, on: boolean) => set({usage: SHARE_USAGE.map(item => item.id).filter(item => item === id ? on : options.usage.includes(item))});
  const busy = Boolean(work);
  const usage = SHARE_USAGE.flatMap(item => {
    if (item.id === 'jev') return [{...item, unavailable: judge.kind === 'ready' ? undefined : judge.kind === 'loading' ? '正在读取判断次数' : judge.problem}];
    const provider = providers.find(entry => entry.id === item.id);
    return provider ? [{...item, unavailable: shareable(provider) ? undefined : provider.loading ? '正在读取用量' : '暂无用量数据'}] : [];
  });
  const row = (item: typeof switches[number]) => <SettingsRow key={item.key} title={item.title} value={item.hint}
    trailing={<Toggle className="settings-row-switch" label={item.title} aria-label={item.title} checked={options[item.key]} disabled={busy} onChange={event => set({[item.key]: event.target.checked})}/>}/>;

  return <Dialog open size="lg" title="分享此刻" description="生成一张动图，关掉的内容不会出现在图里。" onClose={onClose}
    footer={<>
      <div className="share-dialog-status" role="status">{toast && <ShareToast toast={toast} platform={platform}
        onReveal={path => void share.reveal(path).catch(() => setToast({kind: 'error', message: '没能打开文件所在的位置。'}))}
        onOpen={url => void openExternalUrl(url, 'bot-chat', shell).catch(() => setToast({kind: 'error', message: '飞书未能打开。'}))}/>}</div>
      <Button disabled={busy} loading={work?.action === 'copy'} onClick={() => void copy()}>{work?.action === 'copy' ? work.label : '复制'}</Button>
      <Button variant="primary" disabled={busy || !!blocked || !chosen} loading={work?.action === 'send'} title={blocked} onClick={() => void send()}>{work?.action === 'send' ? work.label : '发到飞书'}</Button>
    </>}>
    <div className="share-dialog">
      <SharePreview>
        {/* As the offscreen card: no device's name, no shell. */}
        <ClientProvider client={client} device={LOCAL_ACTIVE_DEVICE}><ShareCard model={model}/></ClientProvider>
      </SharePreview>
      <div className="share-options">
        <SettingsGroup label="显示">
          {row(switches[0]!)}
          <SettingsRow title="用量" value="可多选"/>
          <div className="usage-sections share-usage-choices" role="group" aria-label="分享哪些用量">
            {usage.map(item => <label key={item.id} className="usage-sections__item share-usage-choice" title={item.unavailable} data-disabled={!!item.unavailable || undefined}>
              <input type="checkbox" checked={options.usage.includes(item.id)} disabled={busy || !!item.unavailable} onChange={event => toggle(item.id, event.target.checked)}/>
              <img src={item.icon} alt="" data-round={item.round}/>{item.name}
            </label>)}
          </div>
          {switches.slice(1).filter(item => item.group === '显示').map(row)}
        </SettingsGroup>
        <SettingsGroup label="打码" footer="群头像和 Bot 的名字不打码。">{switches.filter(item => item.group === '打码').map(row)}</SettingsGroup>
        <SettingsGroup label="发到飞书" footer={blocked ?? '只能私聊发给这个 Bot 的管理员。'}>
          {chosen ? <SettingsRow title={<span className="share-recipient">
            由<Choice label="发图的 Bot" value={chosen.bot.agentId} disabled={busy}
              options={shareSenders(targets.kind === 'ready' ? targets.bots : []).map(bot => ({value: bot.agentId, label: bot.name}))}
              onChange={agentId => {
                const bot = shareSenders(targets.kind === 'ready' ? targets.bots : []).find(item => item.agentId === agentId);
                if (bot) choose({agentId: bot.agentId, openId: shareChoice([bot])!.recipient.openId});
              }}/>
            私聊发给<Choice label="收图的人" value={chosen.recipient.openId} disabled={busy}
              options={chosen.bot.recipients.map(person => ({value: person.openId, label: recipientName(person)}))}
              onChange={openId => choose({agentId: chosen.bot.agentId, openId})}/>
          </span>}/> : <SettingsRow title="由 Bot 私聊发给它的管理员" disabled/>}
        </SettingsGroup>
      </div>
    </div>
  </Dialog>;
}

/** One name, or a menu when there are several to pick from. */
function Choice({label, value, options, disabled, onChange}: {label: string; value: string; options: {value: string; label: string}[]; disabled: boolean; onChange: (value: string) => void}) {
  if (options.length < 2) return <strong>{options.find(option => option.value === value)?.label ?? options[0]?.label}</strong>;
  return <SelectControl presentation="dropdown" className="share-recipient-choice" label={label} value={value} options={options} disabled={disabled} onChange={onChange}/>;
}

function ShareToast({toast, platform, onReveal, onOpen}: {toast: Toast; platform?: string; onReveal: (path: string) => void; onOpen: (url: string) => void}) {
  if (toast.kind === 'error') return <p className="share-toast" data-tone="danger">{toast.message}</p>;
  if (toast.kind === 'copied') return <p className="share-toast">已复制，可以粘贴到飞书或微信<button type="button" className="share-toast-action" onClick={() => onReveal(toast.path)}>{revealLabel(platform)}</button></p>;
  return <p className="share-toast">{`已发到 ${toast.name} 和 ${toast.bot} 的私聊`}{toast.url && <button type="button" className="share-toast-action" onClick={() => onOpen(toast.url!)}>打开飞书</button>}</p>;
}

/** The card at its own width, scaled down to the column; still live, so its badges turn under the pointer. */
function SharePreview({children}: {children: ReactNode}) {
  const pane = useRef<HTMLDivElement>(null), card = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({scale: 0, width: 0, height: 0});
  useEffect(() => {
    const outer = pane.current, inner = card.current;
    if (!outer || !inner) return;
    const measure = () => {
      const width = inner.offsetWidth, height = inner.offsetHeight;
      const room = outer.clientWidth - 2 * parseFloat(getComputedStyle(outer).paddingLeft || '0');
      setSize({scale: width ? Math.min(1, room / width) : 0, width, height});
    };
    const observer = new ResizeObserver(measure);
    observer.observe(outer);
    observer.observe(inner);
    measure();
    return () => observer.disconnect();
  }, []);
  return <div className="share-preview" ref={pane} aria-label="分享图预览">
    <span className="share-preview-note">GIF 预览</span>
    <div className="share-preview-frame" style={{width: size.width * size.scale, height: size.height * size.scale}}>
      <div ref={card} className="share-preview-card" style={{transform: `scale(${size.scale})`, visibility: size.scale ? undefined : 'hidden'}}>{children}</div>
    </div>
  </div>;
}
