import {useEffect, useRef, useState} from 'react';
import {communityFailureMessages, publicDisplayNameSchema, type AccountProfile, type AccountStatus, type CommunityRequest, type CommunityShell} from '@vonvon/protocol';
import {Button, FormField, InlineNotice} from '../reference/components/ui';
import {useCommunity} from '../community/community-context';
import {SettingsGroup} from '../reference/components/system-settings';

type Identity = Extract<AccountStatus, {kind: 'signedIn'}>;
export function AccountPublicProfile({accountId, identity}: {accountId: string; identity?: Identity}) {
  const community = useCommunity();
  return community?.shell ? <PublicProfile accountId={accountId} identity={identity} shell={community.shell}/> : null;
}

type ProfileState = {kind: 'loading'} | {kind: 'failed'} | {kind: 'unknown'} | {kind: 'ready'; saved: string};
type AvatarChange = NonNullable<Extract<CommunityRequest, {type: 'saveProfile'}>['avatar']>;

export function PublicProfile({accountId, shell, identity}: {accountId: string; shell: CommunityShell; identity?: Identity}) {
  const [state, setState] = useState<ProfileState>({kind: 'loading'});
  const [name, setName] = useState('');
  const [revision, setRevision] = useState<number>();
  const [savedAvatar, setSavedAvatar] = useState<string>();
  const [avatar, setAvatar] = useState<AvatarChange>({kind: 'keep'});
  const [preview, setPreview] = useState<string>();
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const active = useRef(0);
  const saving = useRef(false);
  function acceptProfile(profile: AccountProfile) {
    setName(profile.displayName); setState({kind: 'ready', saved: profile.displayName}); setRevision(profile.revision);
    setSavedAvatar(profile.avatarDataUrl); setPreview(profile.avatarDataUrl); setAvatar({kind: 'keep'});
  }
  useEffect(() => {
    const generation = ++active.current;
    saving.current = false; setPending(false); setFeedback(undefined); setAvatar({kind: 'keep'}); setPreview(undefined); setRevision(undefined);
    setState({kind: 'loading'});
    void shell.request({type: 'profile', accountId}).then(profile => {
      if (active.current !== generation) return;
      acceptProfile(profile);
    }, () => {if (active.current === generation) setState({kind: 'failed'});});
    return () => {active.current++;};
    // Identity changes when a saved profile is published; do not erase an in-progress edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, shell, attempt]);
  const parsed = publicDisplayNameSchema.safeParse(name);
  const invalid = !parsed.success ? '请输入 1–60 个字，不含 @ 或控制字符。' : undefined;
  const unchanged = state.kind === 'ready' && parsed.success && parsed.data === state.saved && avatar.kind === 'keep';
  async function readUncertainProfile(generation: number) {
    try {
      const profile = await shell.request({type: 'profile', accountId});
      if (active.current !== generation) return;
      setRevision(profile.revision);
      setFeedback(`当前读到的云端昵称为「${profile.displayName}」。请核对后明确保存希望使用的资料。`);
    } catch {
      if (active.current === generation) setFeedback('暂时无法读取云端资料。可以重新读取，或明确保存当前输入。');
    }
  }
  async function reread() {
    if (saving.current) return;
    const generation = active.current;
    saving.current = true; setPending(true);
    try {await readUncertainProfile(generation);}
    finally {if (active.current === generation) {saving.current = false; setPending(false);}}
  }
  async function chooseAvatar(file: File | undefined) {
    if (!file || saving.current) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 2 * 1024 * 1024 || file.size === 0) {
      setFeedback('请选择不超过 2 MiB 的 PNG、JPEG 或 WebP 静态图片。'); return;
    }
    const generation = active.current;
    saving.current = true; setPending(true); setFeedback(undefined);
    try {
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('read_failed'));
        reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('read_failed'));
        reader.readAsDataURL(file);
      });
      if (active.current !== generation) return;
      const base64 = data.slice(data.indexOf(',') + 1);
      setAvatar({kind: 'replace', base64}); setPreview(data);
      setFeedback('头像将在保存时居中裁成方形。');
    } catch {if (active.current === generation) setFeedback('无法读取这张图片，请重新选择。');}
    finally {if (active.current === generation) {saving.current = false; setPending(false);}}
  }
  async function save() {
    if (saving.current || (state.kind !== 'ready' && state.kind !== 'unknown') || !parsed.success || unchanged) return;
    const generation = active.current;
    saving.current = true; setPending(true); setFeedback(undefined);
    try {
      const profile = await shell.request({type: 'saveProfile', accountId, requestId: crypto.randomUUID(), displayName: parsed.data,
        ...(avatar.kind !== 'keep' && {avatar}), ...(revision !== undefined && {revision})});
      if (active.current !== generation) return;
      acceptProfile(profile); setFeedback('个人资料已保存。');
    } catch (error) {
      if (active.current !== generation) return;
      if (error instanceof Error && error.message.includes(communityFailureMessages.invalid_logo)) {
        setFeedback('头像未通过校验。请选择最大 2048 × 2048 像素、不超过 2 MiB 的 PNG、JPEG 或 WebP 静态图片。');
        return;
      }
      setState({kind: 'unknown'}); setFeedback(undefined);
      await readUncertainProfile(generation);
    }
    finally {if (active.current === generation) {saving.current = false; setPending(false);}}
  }
  return <SettingsGroup label="个人资料" footer="App 和你的配方使用同一个账号昵称。修改头像或昵称不会改变用户 ID。">
    <div className="account-public-profile">
      {state.kind === 'loading' ? <p role="status">正在读取个人资料…</p> : state.kind === 'failed' ? <InlineNotice title="暂时无法读取个人资料" tone="warning"><Button onClick={() => setAttempt(value => value + 1)}>重试</Button></InlineNotice> : <form onSubmit={event => {event.preventDefault(); void save();}}>
        {state.kind === 'unknown' && <InlineNotice title="保存结果尚未确认" tone="warning">云端可能已更新资料。可以重新读取核对，或明确保存当前输入。<Button type="button" disabled={pending} onClick={() => {void reread();}}>重新读取</Button></InlineNotice>}
        <FormField label="昵称" htmlFor="account-public-name" description="修改昵称后，App 和你所有配方上的昵称会一起更新。" error={invalid}>
          <input id="account-public-name" value={name} disabled={pending} autoComplete="nickname" aria-invalid={Boolean(invalid)} aria-describedby={`account-public-name-description${invalid ? ' account-public-name-error' : ''}`} onChange={event => {setName(event.target.value); setFeedback(undefined);}}/>
        </FormField>
        <FormField label="头像" htmlFor="account-profile-avatar" description="PNG、JPEG 或 WebP 静态图片，最大 2048 × 2048 像素、2 MiB；保存时居中裁成方形。">
          <div className="account-profile-avatar-edit">
            <span className="account-avatar" data-size="large" aria-label="头像预览"><span>{Array.from(name).slice(0, 2).join('')}</span>{(preview ?? (avatar.kind === 'keep' ? identity?.avatarDataUrl : undefined)) && <img src={preview ?? identity?.avatarDataUrl} alt=""/>}</span>
            <input id="account-profile-avatar" type="file" accept="image/png,image/jpeg,image/webp" disabled={pending} onChange={event => {const file = event.target.files?.[0]; event.target.value = ''; void chooseAvatar(file);}}/>
            {(savedAvatar || avatar.kind === 'replace') && <Button type="button" disabled={pending} onClick={() => {setAvatar({kind: 'remove'}); setPreview(undefined); setFeedback('保存后恢复登录方式提供的头像。');}}>恢复默认头像</Button>}
          </div>
        </FormField>
        {feedback && <p className="account-profile-feedback" role="status">{feedback}</p>}
        <div className="account-panel__actions"><Button type="submit" variant="primary" disabled={pending || !parsed.success || unchanged}>{pending ? '保存中…' : '保存资料'}</Button></div>
      </form>}
    </div>
  </SettingsGroup>;
}
