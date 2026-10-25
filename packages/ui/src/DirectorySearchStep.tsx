import {useEffect, useId, useRef, useState} from 'react';
import {ArrowUp, ChevronRight, Folder, RefreshCw, Search} from 'lucide-react';
import type {DirectoryEntry, FolderChoice} from '@vonvon/protocol';
import {useClient} from './client-context';
import {IconButton} from './reference/components/ui';
import './DirectorySearchStep.css';

/** Searches the daemon's filesystem in both web and desktop, without a native picker. */
export function DirectorySearchStep({onChoose, onBusyChange}: {
  onChoose: (folder: FolderChoice) => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const client = useClient();
  const [query, setQuery] = useState('');
  const [entries, setEntries] = useState<DirectoryEntry[]>([]);
  const [parent, setParent] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(true);
  const [choosing, setChoosing] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const results = useRef<HTMLDivElement>(null);
  const alive = useRef(true);
  const submitting = useRef(false);
  const busyChanged = useRef(onBusyChange);
  busyChanged.current = onBusyChange;
  const listId = useId();

  useEffect(() => {
    alive.current = true;
    input.current?.focus();
    return () => { alive.current = false; busyChanged.current?.(false); };
  }, []);
  useEffect(() => { busyChanged.current?.(choosing); }, [choosing]);
  useEffect(() => {
    results.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({block: 'nearest'});
  }, [active, entries]);
  useEffect(() => {
    let current = true;
    setLoading(true); setError(''); setActive(0); setEntries([]); setParent(null); setTruncated(false);
    const timer = setTimeout(() => {
      void client.directory({type: 'suggest', query}).then(reply => {
        if (!current) return;
        if (reply.kind !== 'suggestions') throw new Error('无法读取目录搜索结果。');
        setEntries(reply.entries); setParent(reply.parent); setTruncated(reply.truncated);
      }).catch(failure => {
        if (current) setError(failure instanceof Error ? failure.message : '无法读取目录。');
      }).finally(() => { if (current) setLoading(false); });
    }, 200);
    return () => { current = false; clearTimeout(timer); };
  }, [client, query, revision]);

  function changeQuery(value: string) {
    if (submitting.current || value === query) return;
    setLoading(true); setEntries([]); setActive(0); setParent(null); setError('');
    setQuery(value);
  }
  function browse(path: string) {
    changeQuery(`${path.replace(/\/$/, '')}/`);
    input.current?.focus();
  }
  async function choose(path: string) {
    if (submitting.current || loading) return;
    submitting.current = true; setChoosing(true); setError('');
    try {
      const reply = await client.directory({type: 'choose', path});
      if (reply.kind !== 'folderChosen') throw new Error('无法选择此目录。');
      if (alive.current) onChoose(reply.folder);
    } catch (failure) {
      if (alive.current) setError(failure instanceof Error ? failure.message : '无法选择此目录。');
    } finally {
      submitting.current = false;
      if (alive.current) setChoosing(false);
    }
  }

  return <div className="join-directory-search">
    <p className="join-directory-context">Bot 所在设备的目录</p>
    <div className="join-directory-input">
      <Search size={17}/>
      <input ref={input} role="combobox" aria-label="搜索目录或输入路径" aria-expanded="true" aria-autocomplete="list" aria-controls={listId}
        aria-activedescendant={entries[active] ? `${listId}-${active}` : undefined} placeholder="搜索目录或输入路径…"
        value={query} disabled={choosing} autoComplete="off" spellCheck={false}
        onChange={event => changeQuery(event.target.value)} onKeyDown={event => {
          if (event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            if (entries.length) setActive(index => (index + (event.key === 'ArrowDown' ? 1 : -1) + entries.length) % entries.length);
          }
          if (event.key === 'Enter') {
            event.preventDefault();
            if (entries[active]) void choose(entries[active].path);
          }
          if (event.key === 'ArrowRight' && event.currentTarget.selectionStart === query.length && entries[active]) {
            event.preventDefault(); browse(entries[active].path);
          }
        }}/>
      {parent && <IconButton size="sm" variant="ghost" label="上一级目录" disabled={choosing || loading} onClick={() => browse(parent)}><ArrowUp size={15}/></IconButton>}
    </div>
    <div ref={results} className="join-directory-results" id={listId} role="listbox" aria-label="目录搜索结果" aria-busy={loading || choosing}>
      {loading ? <p className="join-directory-empty" role="status">正在查找目录…</p> : entries.map((entry, index) =>
        <div key={entry.path} role="option" aria-selected={index === active} id={`${listId}-${index}`} className="join-directory-option" onMouseEnter={() => setActive(index)}>
          <button className="join-directory-select" type="button" disabled={choosing} onClick={() => void choose(entry.path)}>
            <Folder size={19} strokeWidth={1.6}/><span><strong>{entry.name}</strong><small>{entry.path}</small></span><span className="join-directory-enter" aria-hidden="true">↵</span>
          </button>
          <IconButton size="sm" variant="ghost" label={`浏览 ${entry.name} 的子目录`} disabled={choosing} onClick={() => browse(entry.path)}><ChevronRight size={15}/></IconButton>
        </div>)}
      {!loading && !entries.length && !error && <p className="join-directory-empty">没有匹配的目录，可输入完整路径。</p>}
    </div>
    {truncated && !loading && !error && <p className="join-directory-hint">仅显示部分目录，可输入更具体的名称或路径。</p>}
    {error && <div className="join-directory-error" role="alert"><span>{error}</span>
      <IconButton size="sm" variant="ghost" label="重试读取目录" disabled={choosing} onClick={() => setRevision(value => value + 1)}><RefreshCw size={15}/></IconButton>
    </div>}
  </div>;
}
