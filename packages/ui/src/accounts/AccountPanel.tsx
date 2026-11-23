import {CircleUserRound} from 'lucide-react';
import {accountStatusText, useAccount} from '../account-context';
import {Button, InlineNotice} from '../reference/components/ui';
import {SettingsGroup, SettingsRow} from '../reference/components/system-settings';
import {AccountAvatar} from './AccountAvatar';
import {AccountIdentifier} from './AccountIdentifier';
import './accounts.css';

export function AccountPanel() {
  const account = useAccount();
  const {status} = account;
  const identity = status?.kind === 'signedIn' ? status : undefined;
  const canLogin = account.supported && (status?.kind === 'signedOut' || status?.kind === 'unavailable' && status.reason !== 'configuration');
  return <section className="account-panel">
    <header className="today-page-heading"><h1>账号</h1></header>
    <div className="account-profile">
      {identity ? <AccountAvatar identity={identity} size="large"/> : <span className="account-profile__icon"><CircleUserRound size={30} strokeWidth={1.5} aria-hidden="true"/></span>}
      <div className="account-profile__copy"><h2>{identity?.displayName ?? 'Vonvon 账号'}</h2><p role="status">{accountStatusText(status, account.supported)}</p></div>
    </div>
    {account.error && <InlineNotice title="操作未完成" tone="warning">{account.error}{identity && account.refresh && <Button onClick={() => void account.refresh?.()}>刷新资料</Button>}</InlineNotice>}
    {identity?.persistence === 'memory' && <InlineNotice title="本次登录仅保留到应用关闭" tone="info">这台电脑的安全存储暂不可用。下次打开 Vonvon Bot 时需要重新登录。</InlineNotice>}
    {identity && <SettingsGroup label="个人资料" footer="昵称和头像在站点账号设置中统一修改。社区配方通过用户 ID 展示账号当前的昵称，改名后也会更新。">
      <SettingsRow className="account-identifier-row" title="用户 ID" description="账号的固定标识，更改昵称和头像不会改变它。" trailing={<AccountIdentifier key={identity.accountId} accountId={identity.accountId}/>}/>
      <SettingsRow title="账号设置" description="在网站管理昵称和头像。" trailing={account.manage ? <Button onClick={() => void account.manage?.()}>在网页管理账号</Button> : <span>请更新桌面应用</span>}/>
    </SettingsGroup>}
    {identity ? <SettingsGroup label="登录信息" footer="退出只结束这台电脑上的账号会话。已配对设备、Bot 和群组设置会保留。">
      <SettingsRow title="登录状态" value="已登录"/>
      <SettingsRow title="退出账号" trailing={<Button onClick={() => void account.logout()}>退出登录</Button>}/>
    </SettingsGroup> : <div className="account-panel__actions">
      {status?.kind === 'signingIn' ? <Button onClick={() => void account.cancelLogin()}>取消登录</Button>
        : canLogin ? <Button variant="primary" onClick={() => void account.login()}>{status.kind === 'unavailable' ? '重试登录' : '注册或登录'}</Button> : null}
    </div>}
  </section>;
}
