import {useEffect, useRef, useState} from 'react';
import {publicDisplayNameSchema, type CommunityShell} from '@vonvon/protocol';
import {Button, FormField, InlineNotice} from '../reference/components/ui';
import {useCommunity} from '../community/community-context';
import {SettingsGroup} from '../reference/components/system-settings';

export function AccountPublicProfile({accountId}: {accountId: string}) {
  const community = useCommunity();
  return community?.shell ? <PublicProfile accountId={accountId} shell={community.shell}/> : null;
}

type ProfileState = {kind: 'loading'} | {kind: 'failed'} | {kind: 'unknown'} | {kind: 'ready'; saved: string};

export function PublicProfile({accountId, shell}: {accountId: string; shell: CommunityShell}) {
  const [state, setState] = useState<ProfileState>({kind: 'loading'});
  const [name, setName] = useState('');
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const active = useRef(0);
  const saving = useRef(false);
  useEffect(() => {
    const generation = ++active.current;
    saving.current = false; setPending(false); setFeedback(undefined);
    setState({kind: 'loading'});
    void shell.request({type: 'profile', accountId}).then(profile => {
      if (active.current !== generation) return;
      setName(profile.displayName); setState({kind: 'ready', saved: profile.displayName});
    }, () => {if (active.current === generation) setState({kind: 'failed'});});
    return () => {active.current++;};
  }, [accountId, shell, attempt]);
  const parsed = publicDisplayNameSchema.safeParse(name);
  const invalid = !parsed.success ? '请输入 1–60 个字，不含 @ 或控制字符。' : undefined;
  async function confirmSaved(generation: number) {
    try {
      const profile = await shell.request({type: 'profile', accountId});
      if (active.current !== generation) return;
      setState({kind: 'ready', saved: profile.displayName});
      setFeedback(`已重新核对云端署名为「${profile.displayName}」。当前输入与云端不同时，可以保存覆盖。`);
    } catch {
      if (active.current === generation) setState({kind: 'unknown'});
    }
  }
  async function reread() {
    if (saving.current) return;
    const generation = active.current;
    saving.current = true; setPending(true);
    try {await confirmSaved(generation);}
    finally {if (active.current === generation) {saving.current = false; setPending(false);}}
  }
  async function save() {
    if (saving.current || (state.kind !== 'ready' && state.kind !== 'unknown') || !parsed.success || (state.kind === 'ready' && parsed.data === state.saved)) return;
    const generation = active.current;
    saving.current = true; setPending(true); setFeedback(undefined);
    try {
      const profile = await shell.request({type: 'saveProfile', accountId, requestId: crypto.randomUUID(), displayName: parsed.data});
      if (active.current !== generation) return;
      setName(profile.displayName); setState({kind: 'ready', saved: profile.displayName}); setFeedback('公开署名已保存。');
    } catch {
      if (active.current !== generation) return;
      setState({kind: 'unknown'}); setFeedback(undefined);
      await confirmSaved(generation);
    }
    finally {if (active.current === generation) {saving.current = false; setPending(false);}}
  }
  return <SettingsGroup label="公开署名" footer="用于社区配方的作者展示。与登录账号的姓名分开，仅在你保存后修改。">
    <div className="account-public-profile">
      {state.kind === 'loading' ? <p role="status">正在读取公开署名…</p> : state.kind === 'failed' ? <InlineNotice title="暂时无法读取公开署名" tone="warning"><Button onClick={() => setAttempt(value => value + 1)}>重试</Button></InlineNotice> : <form onSubmit={event => {event.preventDefault(); void save();}}>
        {state.kind === 'unknown' && <InlineNotice title="保存结果尚未确认" tone="warning">云端可能已更新署名。可以重新读取核对，或明确保存当前输入覆盖云端值。<Button type="button" disabled={pending} onClick={() => {void reread();}}>重新读取</Button></InlineNotice>}
        <FormField label="作者署名" htmlFor="account-public-name" description={feedback ?? '修改后，你已发布配方上的署名也会更新。'} error={invalid}>
          <div className="account-public-profile__edit"><input id="account-public-name" value={name} disabled={pending} autoComplete="off" aria-invalid={Boolean(invalid)} aria-describedby={`account-public-name-description${invalid ? ' account-public-name-error' : ''}`} onChange={event => {setName(event.target.value); setFeedback(undefined);}}/><Button type="submit" variant="primary" disabled={pending || !parsed.success || (state.kind === 'ready' && parsed.data === state.saved)}>{pending ? '保存中…' : '保存署名'}</Button></div>
        </FormField>
      </form>}
    </div>
  </SettingsGroup>;
}
