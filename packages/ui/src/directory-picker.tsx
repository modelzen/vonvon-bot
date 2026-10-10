import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { DirectoryEntry, FolderChoice } from '@vonvon/protocol';
import { Button, InlineNotice } from './reference/components/ui';
import { Dialog } from './reference/components/ui/Dialog';
import { useClient } from './client-context';

type Picker = () => Promise<FolderChoice | null>;
const PickerContext = createContext<Picker | null>(null);
type Request = { resolve: (value: FolderChoice | null) => void };

export function useDirectoryPicker(): Picker {
  const picker = useContext(PickerContext);
  if (!picker) throw new Error('Directory picker provider is missing');
  return picker;
}

export function DirectoryPickerProvider({ children }: { children: ReactNode }) {
  const client = useClient();
  const [request, setRequest] = useState<Request | null>(null);
  const pending = useRef<Promise<FolderChoice | null> | null>(null);
  const owner = useRef<Request | null>(null);
  const [path, setPath] = useState<string>();
  const [parent, setParent] = useState<string | null>(null);
  const [entries, setEntries] = useState<DirectoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => () => {
    owner.current?.resolve(null);
    owner.current = null;
    pending.current = null;
  }, []);
  useEffect(() => {
    if (!request) return;
    let active = true;
    setLoading(true);
    void client.directory({ type: 'list', ...(path ? { path } : {}) }).then(reply => {
      if (!active) return;
      if (reply.kind !== 'entries') throw new Error('无法读取目录。');
      setPath(reply.path);
      setParent(reply.parent);
      setEntries(reply.entries);
      setError('');
    }).catch(failure => { if (active) setError(failure instanceof Error ? failure.message : '无法读取目录。'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [client, request, path]);
  function finish(folder: FolderChoice | null) {
    if (!request || owner.current !== request) return;
    request.resolve(folder);
    owner.current = null;
    pending.current = null;
    setRequest(null);
    setPath(undefined);
    setEntries([]);
    setError('');
  }
  async function choose() {
    if (!path || loading || !request || owner.current !== request) return;
    setLoading(true);
    try {
      const reply = await client.directory({ type: 'choose', path });
      if (reply.kind !== 'folderChosen') throw new Error('无法选择目录。');
      finish(reply.folder);
    } catch (failure) {
      if (owner.current !== request) return;
      setError(failure instanceof Error ? failure.message : '无法选择目录。');
      setLoading(false);
    }
  }
  const pick: Picker = () => {
    if (!pending.current) pending.current = new Promise(resolve => {
      owner.current = { resolve };
      setRequest(owner.current);
    });
    return pending.current;
  };
  return <PickerContext.Provider value={pick}>
    {children}
    {request && <Dialog open title="选择工作目录" onClose={() => finish(null)}>
      <div className="page-stack">
        <p aria-live="polite">{path ?? '正在读取目录…'}</p>
        {error && <InlineNotice title="目录读取失败" tone="warning">{error}</InlineNotice>}
        {parent && <Button disabled={loading} onClick={() => setPath(parent)}>返回上一级</Button>}
        <div role="list" aria-label="目录列表">
          {entries.filter(entry => !entry.hidden).map(entry => <div role="listitem" key={entry.path}>
            <Button disabled={loading} onClick={() => setPath(entry.path)}>{entry.name}</Button>
          </div>)}
        </div>
        <div><Button disabled={!path || loading} onClick={() => void choose()}>选择当前目录</Button><Button onClick={() => finish(null)}>取消</Button></div>
      </div>
    </Dialog>}
  </PickerContext.Provider>;
}
