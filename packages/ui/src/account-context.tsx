import {createContext, useContext, useEffect, useMemo, useState, type ReactNode} from 'react';
import type {AccountShell, AccountStatus} from '@vonvon/protocol';

type AccountContextValue = {
  supported: boolean;
  status?: AccountStatus;
  error?: string;
  login: () => Promise<void>;
  cancelLogin: () => Promise<void>;
  logout: () => Promise<void>;
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
    const unsubscribe = account.onStatus(next => {
      received = true;
      if (active) {setStatus(next); setError(undefined);}
    });
    void account.status().then(next => {
      if (active && !received) setStatus(next);
    }, () => {
      if (active && !received) setError('账户状态暂时无法读取，请稍后重试。');
    });
    return () => {active = false; unsubscribe();};
  }, [account]);
  const value = useMemo<AccountContextValue>(() => {
    if (!account) return unsupported;
    const run = async (action: () => Promise<AccountStatus>, failure: string) => {
      setError(undefined);
      try {await action();} catch {setError(failure);}
    };
    return {supported: true, status, error,
      login: () => run(() => account.login(), '登录未完成，请重试。'),
      cancelLogin: () => run(() => account.cancelLogin(), '未能取消登录，请重试。'),
      logout: () => run(() => account.logout(), '未能退出登录，请重试。'),
    };
  }, [account, status, error]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useAccount() {return useContext(Context);}

export const accountProviderNames = {github: 'GitHub', google: 'Google', apple: 'Apple'} as const;
export function accountStatusText(status: AccountStatus | undefined, supported: boolean): string {
  if (!supported) return '账户功能在 Vonvon Bot 桌面应用中提供。';
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
    }[status.reason] : '登录 Vonvon，使用社区中的配方。';
  }
}
