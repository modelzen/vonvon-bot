import {createContext, useContext, useEffect, useMemo, useState, type ReactNode} from 'react';
import type {AccountShell, AccountStatus} from '@vonvon/protocol';

type AccountContextValue = {
  supported: boolean;
  status?: AccountStatus;
  error?: string;
  login: () => Promise<void>;
  cancelLogin: () => Promise<void>;
  logout: () => Promise<void>;
  manage?: () => Promise<void>;
  refresh?: () => Promise<void>;
};
const unsupported: AccountContextValue = {
  supported: false, login: async () => {}, cancelLogin: async () => {}, logout: async () => {},
};
const Context = createContext<AccountContextValue>(unsupported);

export function AccountProvider({account, children}: {account?: AccountShell; children: ReactNode}) {
  const [status, setStatus] = useState<AccountStatus>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    setStatus(undefined);
    setError(undefined);
    if (!account) return;
    let active = true;
    let received = false;
    let accountId: string | undefined;
    let generation = 0;
    let refreshAttempt: Promise<AccountStatus> | undefined;
    const accept = (next: AccountStatus) => {
      const nextId = next.kind === 'signedIn' ? next.accountId : undefined;
      if (nextId !== accountId) {accountId = nextId; ++generation; refreshAttempt = undefined;}
      if (active) {setStatus(next); setError(undefined);}
    };
    const unsubscribe = account.onStatus(next => {
      received = true;
      accept(next);
    });
    void account.status().then(next => {
      if (active && !received) accept(next);
    }, () => {
      if (active && !received) setError('账户状态暂时无法读取，请稍后重试。');
    });
    const onFocus = () => {
      if (!active || !accountId || !account.refresh || refreshAttempt) return;
      const current = generation;
      const attempt = account.refresh();
      refreshAttempt = attempt;
      void attempt.then(next => {
        if (active && current === generation) accept(next);
      }, () => {
        if (active && current === generation) setError('暂时无法更新账号资料，请重试。');
      }).finally(() => {if (refreshAttempt === attempt) refreshAttempt = undefined;});
    };
    if (typeof window !== 'undefined') window.addEventListener('focus', onFocus);
    return () => {active = false; unsubscribe(); if (typeof window !== 'undefined') window.removeEventListener('focus', onFocus);};
  }, [account]);
  const value = useMemo<AccountContextValue>(() => {
    if (!account) return unsupported;
    const run = async (action: () => Promise<unknown>, failure: string) => {
      setError(undefined);
      try {await action();} catch {setError(failure);}
    };
    return {supported: true, status, error,
      login: () => run(() => account.login(), '登录未完成，请重试。'),
      cancelLogin: () => run(() => account.cancelLogin(), '未能取消登录，请重试。'),
      logout: () => run(() => account.logout(), '未能退出登录，请重试。'),
      ...(account.manage && {manage: () => run(async () => {await account.manage?.();}, '未能打开账号设置，请重试。')}),
      ...(account.refresh && {refresh: () => run(async () => {await account.refresh?.();}, '暂时无法更新账号资料，请重试。')}),
    };
  }, [account, status, error]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useAccount() {return useContext(Context);}

export const accountProviderNames = {github: 'GitHub', google: 'Google', apple: 'Apple'} as const;
export function accountStatusText(status: AccountStatus | undefined, supported: boolean): string {
  if (!supported) return '当前环境不支持账户功能，请使用最新版 Vonvon Bot 桌面应用。';
  if (!status) return '正在读取账户状态…';
  switch (status.kind) {
    case 'signedIn': return `通过 ${accountProviderNames[status.provider]} 登录`;
    case 'signingIn': return '等待登录完成…';
    case 'unavailable': return {
      configuration: '账户服务尚未配置，请稍后再试。',
      offline: '暂时无法连接账户服务，请检查网络后重试。',
      storage: '无法读取或清除本机的登录信息，请稍后重试。',
    }[status.reason];
    case 'signedOut': return status.reason ? {
      failed: '登录未完成，请重试。', expired: '登录已过期，请重新登录。',
      cancelled: '已取消登录。', sessionExpired: '登录已失效，请重新登录。',
    }[status.reason] : '使用 GitHub 等方式继续，首次使用会自动创建账号。';
  }
}
