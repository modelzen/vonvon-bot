import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import {ArrowUp, ChevronRight, Folder, X} from 'lucide-react';
import type { DirectoryEntry, FolderChoice } from '@vonvon/protocol';
import { Button, InlineNotice } from './reference/components/ui';
import { Dialog } from './reference/components/ui/Dialog';
import { useActiveDevice, useClient, useShellCapabilities } from './client-context';
import { whereName } from './device-copy';
import './directory-picker.css';

type Picker = () => Promise<FolderChoice | null>;
/** devices-ui-2 4.3: what to open as a path rather than search for. `/…`, `~` and `~/…` or `~\…`, `C:\…` or `C:/…`, and
 * `\\server\share`; the daemon expands `~` by its own platform's rule. */
export const looksLikePath = (text: string): boolean => /^(\/|~([\\/]|$)|[A-Za-z]:[\\/]|\\\\)/.test(text);
type MultiPicker = () => Promise<FolderChoice[] | null>;
const PickerContext = createContext<{single: Picker; multiple: MultiPicker} | null>(null);
type Request = { multiple: boolean; resolve: (value: FolderChoice[] | null) => void };
export function useDirectoryPicker(): Picker {
  const picker = useContext(PickerContext);
  if (!picker) throw new Error('Directory picker provider is missing');
  return picker.single;
}
export function useDirectoriesPicker(): MultiPicker {
  const picker = useContext(PickerContext);
  if (!picker) throw new Error('Directory picker provider is missing');
  return picker.multiple;
}

// A compact host directory browser: native folder controls on desktop, the daemon's
// filesystem on the web. Selection survives browsing; cancellation never saves references.
export function DirectoryPickerProvider({ children }: { children: ReactNode }) {
  const client = useClient();
  const shell = useShellCapabilities();
  const where = useActiveDevice();
  const [request, setRequest] = useState<Request | null>(null);
  const pending = useRef<Promise<FolderChoice[] | null> | null>(null);
  const owner = useRef<Request | null>(null);
  const [path, setPath] = useState<string>();
  const [requestedPath, setRequestedPath] = useState<string>();
  const [browseVersion, setBrowseVersion] = useState(0);
  const [parent, setParent] = useState<string | null>(null);
  const [entries, setEntries] = useState<DirectoryEntry[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [choosing, setChoosing] = useState(false);
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
    setError('');
    void client.directory({ type: 'list', ...(requestedPath ? { path: requestedPath } : {}) }).then(reply => {
      if (!active) return;
      if (reply.kind !== 'entries') throw new Error('无法读取目录。');
      setPath(reply.path);
      setParent(reply.parent);
      setEntries(reply.entries);
      if (reply.truncated) setError('目录较多，当前显示部分目录。可输入完整路径前往。');
    }).catch(failure => { if (active) setError(failure instanceof Error ? failure.message : '无法读取目录。'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [client, request, requestedPath, browseVersion]);
  function finish(folders: FolderChoice[] | null) {
    if (!request || owner.current !== request) return;
    request.resolve(folders);
    owner.current = null;
    pending.current = null;
    setRequest(null);
    setPath(undefined);
    setRequestedPath(undefined);
    setEntries([]);
    setSelected([]);
    setSearch('');
    setError('');
    setChoosing(false);
  }
  async function admit(paths: string[]) {
    const folders: FolderChoice[] = [];
    for (const path of paths) {
      const reply = await client.directory({type: 'choose', path});
      if (reply.kind !== 'folderChosen') throw new Error('无法选择目录。');
      if (!folders.some(folder => folder.displayPath === reply.folder.displayPath)) folders.push(reply.folder);
    }
    return folders;
  }
  async function choose() {
    if (choosing || loading || !request || owner.current !== request) return;
    const paths = request.multiple ? selected : path ? [path] : [];
    if (!paths.length) return;
    const current = request;
    setChoosing(true);
    try {
      const folders = await admit(paths);
      if (owner.current === current) finish(folders);
    } catch (failure) {
      if (owner.current !== current) return;
      setError(failure instanceof Error ? failure.message : '无法选择目录。');
      setChoosing(false);
    }
  }
  function toggle(path: string) {
    setSelected(current => current.includes(path) ? current.filter(value => value !== path) : current.length < 64 ? [...current, path] : current);
  }
  function browse(path: string) {setSearch(''); setRequestedPath(path); setBrowseVersion(value => value + 1);}
  function pick(multiple: boolean): Promise<FolderChoice[] | null> {
    if (pending.current) return pending.current;
    if (shell?.chooseDirectoryPaths) {
      const task = shell.chooseDirectoryPaths(multiple).then(paths => paths ? admit(paths) : null);
      pending.current = task;
      void task.finally(() => {if (pending.current === task) pending.current = null;}).catch(() => {});
      return task;
    }
    pending.current = new Promise(resolve => {
      owner.current = { multiple, resolve };
      setRequest(owner.current);
    });
    return pending.current;
  }
  const visible = entries.filter(entry => !entry.hidden && (!search || entry.name.toLocaleLowerCase().includes(search.toLocaleLowerCase())));
  return <PickerContext.Provider value={{single: async () => (await pick(false))?.[0] ?? null, multiple: () => pick(true)}}>
    {children}
    {request && <Dialog open title={`${request.multiple ? '添加' : '选择'}${whereName(where)}上的文件夹`} onClose={() => finish(null)} footer={<>
      <span className="directory-selection-count">{request.multiple && `${selected.length} 个已选`}</span>
      <Button onClick={() => finish(null)}>取消</Button>
      <Button variant="primary" loading={choosing} disabled={loading || choosing || (request.multiple ? selected.length === 0 : !path)} onClick={() => void choose()}>{request.multiple ? '添加所选目录' : '选择此目录'}</Button>
    </>}>
      <div className="directory-browser">
        <div className="directory-browser-location"><Button size="sm" aria-label="上一级目录" disabled={!parent || loading || choosing} onClick={() => parent && browse(parent)}><ArrowUp size={16}/></Button><code title={path}>{path ?? '正在读取…'}</code></div>
        <form className="directory-browser-search" onSubmit={event => {event.preventDefault(); if (looksLikePath(search)) browse(search);}}><input aria-label="搜索目录或输入路径" placeholder={'搜索此处，或输入路径（如 /srv/app、C:\\work）'} value={search} onChange={event => setSearch(event.target.value)}/>{looksLikePath(search) && <Button size="sm" type="submit" disabled={loading || choosing}>前往</Button>}</form>
        {error && <InlineNotice title="目录提示" tone="warning">{error}</InlineNotice>}
        {request.multiple && path && <label className="directory-current"><input type="checkbox" checked={selected.includes(path)} disabled={loading || choosing} onChange={() => toggle(path)}/>选择当前目录</label>}
        <div className="directory-browser-list" role="list" aria-label="目录列表" aria-busy={loading}>
          {visible.map(entry => <div className="directory-browser-row" role="listitem" key={entry.path}>
            {request.multiple && <input type="checkbox" aria-label={`选择 ${entry.name}`} checked={selected.includes(entry.path)} disabled={loading || choosing || (selected.length >= 64 && !selected.includes(entry.path))} onChange={() => toggle(entry.path)}/>}
            <button type="button" disabled={loading || choosing} onClick={() => browse(entry.path)}><Folder size={16}/><span>{entry.name}</span><ChevronRight size={14}/></button>
          </div>)}
          {!loading && !visible.length && <p className="directory-empty">{search ? '没有匹配的目录' : '没有子目录'}</p>}
        </div>
        {request.multiple && selected.length > 0 && <div className="directory-selected" aria-label="已选目录">{selected.map(path => <div key={path}><code title={path}>{path}</code><button type="button" aria-label={`取消选择 ${path}`} disabled={choosing} onClick={() => toggle(path)}><X size={14}/></button></div>)}</div>}
      </div>
    </Dialog>}
  </PickerContext.Provider>;
}
