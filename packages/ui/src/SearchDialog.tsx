import {useEffect, useId, useRef, useState} from 'react';
import {
  Activity, AppWindow, ArrowRight, Bot, Brain, Cable, ChartColumn, Cpu, FolderOpen,
  Info, LayoutGrid, PanelTop, Search, Settings2, Users, X, type LucideIcon,
} from 'lucide-react';
import {Dialog} from './reference/components/ui/Dialog';
import {findEntries, type SearchEntry} from './search';
import './search.css';

function Highlight({text, query}: {text: string; query: string}) {
  const term = query.trim().split(/\s+/)[0]?.toLocaleLowerCase();
  const start = term ? text.toLocaleLowerCase().indexOf(term) : -1;
  if (start < 0 || !term) return <>{text}</>;
  return <>{text.slice(0, start)}<mark>{text.slice(start, start + term.length)}</mark>{text.slice(start + term.length)}</>;
}

const pageIcons: Record<string, LucideIcon> = {
  agents: LayoutGrid, groups: Users, projects: FolderOpen, usage: ChartColumn,
  providers: Cpu, environment: Cable, application: AppWindow, secrets: Brain,
  diagnostics: Activity, setup: Cable,
};
function ResultIcon({entry}: {entry: SearchEntry}) {
  const selection = entry.destination.selection?.kind;
  const Icon = entry.kind === 'page' ? pageIcons[entry.id] ?? PanelTop
    : entry.kind === 'item' ? selection === 'agent' ? Bot : selection === 'project' ? FolderOpen : Users
    : entry.kind === 'action' ? ArrowRight : Settings2;
  return <span className="desktop-search-icon" aria-hidden="true"><Icon size={17} strokeWidth={1.7}/></span>;
}
function visibleTitle(entry: SearchEntry): string {
  return entry.kind === 'page' && entry.id === 'usage' ? '用量'
    : entry.kind === 'page' && entry.id === 'setup' ? '飞书连接' : entry.title;
}
function contextLine(entry: SearchEntry): string | undefined {
  if (entry.kind === 'page' || !entry.context || entry.context === entry.title) return undefined;
  if (entry.kind === 'item' && ['Bot', '飞书群', '项目'].includes(entry.context)) return undefined;
  return entry.context;
}

export function SearchDialog({open, entries, onClose, onSelect}: {
  open: boolean; entries: SearchEntry[]; onClose: () => void; onSelect: (entry: SearchEntry) => void;
}) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const resultList = useRef<HTMLDivElement>(null);
  const id = useId();
  const listId = `${id}-options`;
  const guideId = `${id}-guide`;
  useEffect(() => {if (!open) {setQuery(''); setActive(0);}}, [open]);
  const results = findEntries(entries, query);
  const selected = Math.min(active, results.length - 1);
  const current = results[selected];
  useEffect(() => {
    if (!open || selected < 0) return;
    resultList.current?.querySelector<HTMLElement>(`[data-result-index="${selected}"]`)?.scrollIntoView({block: 'nearest', behavior: 'instant'});
  }, [open, selected, query]);
  const choose = () => {if (current) onSelect(current);};
  return <Dialog open={open} title="搜索 Vonvon Bot" variant="search" onClose={onClose} initialFocusRef={input}>
    <div className="desktop-search">
      <div className="desktop-search-heading">
        <Search size={19} strokeWidth={1.8} aria-hidden="true"/>
        <input
          ref={input} role="combobox" aria-label="搜索设置、Bot 或飞书群" aria-autocomplete="list"
          aria-controls={listId} aria-expanded={open} aria-activedescendant={selected >= 0 ? `${id}-option-${selected}` : undefined}
          aria-describedby={current?.destination.guide ? guideId : undefined}
          autoComplete="off" spellCheck={false} value={query}
          onChange={event => {setQuery(event.target.value); setActive(0);}}
          onKeyDown={event => {
            if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
            if (event.key === 'ArrowDown') {event.preventDefault(); setActive(index => Math.min(index + 1, results.length - 1));}
            if (event.key === 'ArrowUp') {event.preventDefault(); setActive(index => Math.max(index - 1, 0));}
            if (event.key === 'Home') {event.preventDefault(); setActive(0);}
            if (event.key === 'End') {event.preventDefault(); setActive(Math.max(0, results.length - 1));}
            if (event.key === 'Enter') {event.preventDefault(); choose();}
          }}
          placeholder="搜索设置、Bot 或飞书群…"
        />
        {query && <button className="desktop-search-clear" type="button" aria-label="清除搜索" title="清除搜索"
          onClick={() => {setQuery(''); setActive(0); input.current?.focus();}}><X size={14} aria-hidden="true"/></button>}
        <kbd className="desktop-search-escape">esc</kbd>
      </div>
      <div className="desktop-search-section">
        <span>{query.trim() ? '搜索结果' : '快速前往'}</span>
        <span role="status">{query.trim() ? `${results.length} 项` : ''}</span>
      </div>
      <div ref={resultList} className="desktop-search-results" id={listId} role="listbox" aria-label="搜索结果">
        {results.map((entry, index) => {
          const context = contextLine(entry);
          return <button key={entry.id} id={`${id}-option-${index}`} data-result-index={index} type="button" role="option" tabIndex={-1}
            aria-selected={index === selected} className={`desktop-search-result${context ? ' has-context' : ''}${index === selected ? ' is-active' : ''}`}
            onMouseEnter={() => setActive(index)} onClick={() => onSelect(entry)}>
            <ResultIcon entry={entry}/>
            <span className="desktop-search-copy">
              <strong title={visibleTitle(entry)}><Highlight text={visibleTitle(entry)} query={query}/></strong>
              {context && <small title={context}>{context}</small>}
            </span>
            {entry.kind === 'item' && !context && <span className="desktop-search-kind">{entry.context}</span>}
            <span className="desktop-search-action" aria-hidden="true">{index === selected && <ArrowRight size={14} strokeWidth={1.8}/>}</span>
          </button>;
        })}
        {query.trim() && results.length === 0 && <div className="desktop-search-empty">
          <Search size={23} strokeWidth={1.5} aria-hidden="true"/>
          <strong>没有找到相关结果</strong>
          <span>试试设置项、Bot 或群聊名称。</span>
        </div>}
      </div>
      <div className="desktop-search-bottom">
        {current?.destination.guide && <div className="desktop-search-guide" id={guideId}>
          <Info size={14} strokeWidth={1.7} aria-hidden="true"/><span>{current.destination.guide}</span>
        </div>}
        <div className="desktop-search-footer">
          <span><kbd>↑</kbd><kbd>↓</kbd><span>选择</span></span>
          <span className={current ? '' : 'is-unavailable'}><kbd>↵</kbd><span>打开</span></span>
        </div>
      </div>
    </div>
  </Dialog>;
}
