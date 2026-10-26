import {createContext, useContext, useEffect, useMemo, useState, type ReactNode} from 'react';
import type {DesktopUpdate} from '@vonvon/protocol';
import {useShellCapabilities} from './client-context';

type Store = readonly [DesktopUpdate | undefined, (update: DesktopUpdate) => void];
export const DesktopUpdateContext = createContext<Store | undefined>(undefined);

/** 桌面端自动检查到的更新状态，以及设置页里手动检查的结果，放在同一处：设置入口的标记和更新面板读的是同一份。 */
export function DesktopUpdateProvider({children}: {children: ReactNode}) {
  const shell = useShellCapabilities();
  const [update, setUpdate] = useState<DesktopUpdate>();
  const subscribe = shell?.onDesktopUpdate;
  useEffect(() => subscribe?.(setUpdate), [subscribe]);
  const store = useMemo<Store>(() => [update, setUpdate], [update]);
  return <DesktopUpdateContext.Provider value={store}>{children}</DesktopUpdateContext.Provider>;
}

/** 没有 Provider 时（单独渲染更新面板）退回面板自己的状态。 */
export function useDesktopUpdate(): Store {
  const shared = useContext(DesktopUpdateContext);
  const local = useState<DesktopUpdate>();
  return shared ?? local;
}
