import {ChevronRight, CircleUserRound} from 'lucide-react';
import type {AccountStatus} from '@vonvon/protocol';
import {accountStatusText} from '../account-context';
import {AccountAvatar} from './AccountAvatar';
import './accounts.css';

export type AccountMenuActions = {status?: AccountStatus; supported: boolean; onLogin: () => void; onManage: () => void; error?: string};

export function AccountMenuItem({account, menu = false}: {account: AccountMenuActions; menu?: boolean}) {
  return <button type="button" role={menu ? 'menuitem' : undefined} tabIndex={menu ? -1 : undefined} className="device-switcher__account-button"
    onClick={account.status?.kind === 'signedOut' ? account.onLogin : account.onManage}>
    {account.status?.kind === 'signedIn' ? <AccountAvatar identity={account.status}/> : <CircleUserRound size={22} strokeWidth={1.5} aria-hidden="true"/>}
    <span className="device-switcher__account-copy"><strong>{account.status?.kind === 'signedIn' ? account.status.displayName : account.status?.kind === 'signedOut' ? '登录 Vonvon' : '账号'}</strong>
      <small>{account.error ?? (account.status?.kind === 'signedIn' ? '账号管理' : accountStatusText(account.status, account.supported))}</small></span>
    <ChevronRight size={13} aria-hidden="true"/>
  </button>;
}
