import {createContext, useContext, useEffect, useRef, useState, type ReactNode} from 'react';
import type {DesktopUpdate} from '@vonvon/protocol';
import {useShellCapabilities} from './client-context';

export type UpdatePhase = 'checking' | 'downloading' | 'installing';
type Operation = {
  phase?: UpdatePhase;
  error?: string;
  run: (action: () => Promise<DesktopUpdate>, phase: UpdatePhase) => Promise<void>;
};
type Store = readonly [DesktopUpdate | undefined, (update: DesktopUpdate) => void, Operation?];
export const DesktopUpdateContext = createContext<Store | undefined>(undefined);

function useUpdateOperation(setUpdate: (update: DesktopUpdate) => void): Operation {
  const [phase, setPhase] = useState<UpdatePhase>();
  const [error, setError] = useState<string>();
  const pending = useRef(false);
  const run: Operation['run'] = async (action, nextPhase) => {
    // Lock synchronously: the toolbar and settings may be clicked before React renders again.
    if (pending.current) return;
    pending.current = true;
    setPhase(nextPhase);
    setError(undefined);
    try {
      setUpdate(await action());
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '更新失败，请重试。');
    } finally {
      // Native installation normally destroys this window before replying. If it does
      // reply without exiting, leave a retry instead of permanently disabling updates.
      pending.current = false;
      setPhase(undefined);
    }
  };
  return {phase, error, run};
}

/** 自动检查、工具栏和设置页共用状态；换页不会丢失下载进度或错误，也不会重复发起安装。 */
export function DesktopUpdateProvider({children}: {children: ReactNode}) {
  const shell = useShellCapabilities();
  const [update, setUpdate] = useState<DesktopUpdate>();
  const operation = useUpdateOperation(setUpdate);
  const subscribe = shell?.onDesktopUpdate;
  useEffect(() => subscribe?.(setUpdate), [subscribe]);
  const store: Store = [update, setUpdate, operation];
  return <DesktopUpdateContext.Provider value={store}>{children}</DesktopUpdateContext.Provider>;
}

export function useDesktopUpdateOperation(store: Store): Operation {
  const local = useUpdateOperation(store[1]);
  return store[2] ?? local;
}

/** 没有 Provider 时（单独渲染更新面板）退回面板自己的状态。 */
export function useDesktopUpdate(): Store {
  const shared = useContext(DesktopUpdateContext);
  const local = useState<DesktopUpdate>();
  return shared ?? local;
}
