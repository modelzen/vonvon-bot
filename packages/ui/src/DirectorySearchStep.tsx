import {useEffect, useId, useRef, useState} from 'react';
import {ArrowUp, ChevronRight, Eye, EyeOff, Folder, RefreshCw, Search} from 'lucide-react';
import type {DirectoryEntry, FolderChoice} from '@vonvon/protocol';
import {useActiveDevice, useClient} from './client-context';
import {whereName} from './device-copy';
import {IconButton} from './reference/components/ui';
import './DirectorySearchStep.css';

/** The query that lists a folder's children: the folder and its own separator, `\` for `C:\…` and `\\server\…`
 * (devices-ui-2 4.3: a Windows device's paths come back in its own form). */
export function browseQuery(path: string): string {
  const separator = /^([A-Za-z]:|\\\\)/.test(path) ? '\\' : '/';
  return `${path.replace(/[\\/]+$/, '')}${separator}`;
}

/** Searches the daemon's filesystem in both web and desktop, without a native picker. */
export function DirectorySearchStep({onChoose, onBusyChange}: {
  onChoose: (folder: FolderChoice) => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const client = useClient();
  const where = useActiveDevice();
  const [query, setQuery] = useState('');
  const [entries, setEntries] = useState<DirectoryEntry[]>([]);
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const [parent, setParent] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(true);
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

  const trimmedQuery = query.trim();
  const explicitDot = trimmedQuery.startsWith('.') || /(?:^|[\\/])\./.test(trimmedQuery);
  const visibleEntries = showHidden || explicitDot
    ? entries
    : entries.filter((entry, index) => !entry.hidden || (index === 0 && entry.path === currentPath));
  const activeIndex = visibleEntries.length ? Math.min(active, visibleEntries.length - 1) : 0;

  useEffect(() => {
    alive.current = true;
    input.current?.focus();
    return () => { alive.current = false; busyChanged.current?.(false); };
  }, []);
  useEffect(() => { busyChanged.current?.(choosing); }, [choosing]);
  useEffect(() => {
    results.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({block: 'nearest'});
  }, [activeIndex, visibleEntries]);
  useEffect(() => {
    let current = true;
    setLoading(true); setError(''); setActive(0); setEntries([]); setCurrentPath(null); setParent(null); setTruncated(false);
    const timer = setTimeout(() => {
      void client.directory({type: 'suggest', query}).then(reply => {
        if (!current) return;
        if (reply.kind !== 'suggestions') throw new Error('无法读取目录搜索结果。');
        setEntries(reply.entries); setCurrentPath(reply.path); setParent(reply.parent); setTruncated(reply.truncated);
      }).catch(failure => {
        if (current) setError(failure instanceof Error ? failure.message : '无法读取目录。');
      }).finally(() => { if (current) setLoading(false); });
    }, 200);
    return () => { current = false; clearTimeout(timer); };
  }, [client, query, revision]);

  function changeQuery(value: string) {
    if (submitting.current || value === query) return;
    setLoading(true); setEntries([]); setCurrentPath(null); setActive(0); setParent(null); setError('');
    setQuery(value);
  }
  function browse(path: string) {
    changeQuery(browseQuery(path));
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
    <div className="join-directory-header">
      <p className="join-directory-context">{`${whereName(where)}上的目录`}</p>
      <button
        type="button"
        className="join-directory-hidden-toggle"
        aria-pressed={showHidden}
        disabled={choosing}
        onClick={() => { setShowHidden(value => !value); setActive(0); }}
      >
        {showHidden ? <Eye size={13} aria-hidden="true"/> : <EyeOff size={13} aria-hidden="true"/>}
        <span>显示隐藏目录</span>
      </button>
    </div>
    <div className="join-directory-input">
      <Search size={17}/>
      <input ref={input} role="combobox" aria-label="搜索目录或输入路径" aria-expanded="true" aria-autocomplete="list" aria-controls={listId}
        aria-activedescendant={visibleEntries[activeIndex] ? `${listId}-${activeIndex}` : undefined} placeholder="搜索目录或输入路径…"
        value={query} disabled={choosing} autoComplete="off" spellCheck={false}
        onChange={event => changeQuery(event.target.value)} onKeyDown={event => {
          if (event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            if (visibleEntries.length) setActive(index => (Math.min(index, visibleEntries.length - 1) + (event.key === 'ArrowDown' ? 1 : -1) + visibleEntries.length) % visibleEntries.length);
          }
          if (event.key === 'Enter') {
            event.preventDefault();
            if (visibleEntries[activeIndex]) void choose(visibleEntries[activeIndex].path);
          }
          if (event.key === 'ArrowRight' && event.currentTarget.selectionStart === query.length && visibleEntries[activeIndex]) {
            event.preventDefault(); browse(visibleEntries[activeIndex].path);
          }
        }}/>
      {parent && <IconButton size="sm" variant="ghost" label="上一级目录" disabled={choosing || loading} onClick={() => browse(parent)}><ArrowUp size={15}/></IconButton>}
    </div>
    <div ref={results} className="join-directory-results" id={listId} role="listbox" aria-label="目录搜索结果" aria-busy={loading || choosing}>
      {loading ? <p className="join-directory-empty" role="status">正在查找目录…</p> : visibleEntries.map((entry, index) =>
        <div key={entry.path} role="option" aria-selected={index === activeIndex} id={`${listId}-${index}`} className="join-directory-option" data-hidden={entry.hidden || undefined} onMouseEnter={() => setActive(index)}>
          <button className="join-directory-select" type="button" disabled={choosing} onClick={() => void choose(entry.path)}>
            <Folder size={19} strokeWidth={1.6}/><span><strong>{entry.name}</strong><small>{entry.path}</small></span><span className="join-directory-enter" aria-hidden="true">↵</span>
          </button>
          <IconButton size="sm" variant="ghost" label={`浏览 ${entry.name} 的子目录`} disabled={choosing} onClick={() => browse(entry.path)}><ChevronRight size={15}/></IconButton>
        </div>)}
      {!loading && !visibleEntries.length && !error && <p className="join-directory-empty">{!showHidden && entries.length > 0 ? '当前仅有隐藏目录，可开启「显示隐藏目录」查看。' : truncated ? '未在当前搜索范围找到目录，可输入完整路径。' : '没有匹配的目录，可输入完整路径。'}</p>}
    </div>
    {truncated && visibleEntries.length > 0 && !loading && !error && <p className="join-directory-hint">仅显示部分目录，可输入更具体的名称或路径。</p>}
    {error && <div className="join-directory-error" role="alert"><span>{error}</span>
      <IconButton size="sm" variant="ghost" label="重试读取目录" disabled={choosing} onClick={() => setRevision(value => value + 1)}><RefreshCw size={15}/></IconButton>
    </div>}
  </div>;
}
