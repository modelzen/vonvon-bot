import {useEffect, useRef, useState} from 'react';
import {ArrowRight, Command, Search, Settings2, Users, Workflow, X} from 'lucide-react';
import {Dialog} from './reference/components/ui/Dialog';
import {findEntries, type SearchEntry} from './search';
import './search.css';

function Highlight({text, query}: {text: string; query: string}) {
  const term = query.trim().split(/\s+/)[0]?.toLocaleLowerCase();
  const start = term ? text.toLocaleLowerCase().indexOf(term) : -1;
  if (start < 0 || !term) return <>{text}</>;
  return <>{text.slice(0, start)}<mark>{text.slice(start, start + term.length)}</mark>{text.slice(start + term.length)}</>;
}
function ResultIcon({entry}: {entry: SearchEntry}) {
  const icon = entry.kind === 'page' ? <Workflow size={17} /> : entry.kind === 'item' ? <Users size={17} /> : entry.kind === 'action' ? <ArrowRight size={17} /> : <Settings2 size={17} />;
  return <span className="desktop-search-icon" aria-hidden="true">{icon}</span>;
}
export function SearchDialog({open, entries, onClose, onSelect}: {
  open: boolean; entries: SearchEntry[]; onClose: () => void; onSelect: (entry: SearchEntry) => void;
}) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const resultList = useRef<HTMLDivElement>(null);
  useEffect(() => {if (!open) {setQuery(''); setActive(0);}}, [open]);
  const results = findEntries(entries, query);
  const selected = Math.min(active, results.length - 1);
  useEffect(() => {
    if (!open || selected < 0) return;
    resultList.current?.querySelector<HTMLElement>(`[data-result-index="${selected}"]`)?.scrollIntoView({block: 'nearest'});
  }, [open, selected, query]);
  const choose = () => {if (selected >= 0 && results[selected]) onSelect(results[selected]);};
  return <Dialog open={open} title="搜索 Vonvon Bot" variant="search" onClose={onClose} initialFocusRef={input}>
    <div className="desktop-search-heading">
      <Search size={20} strokeWidth={2} aria-hidden="true" />
      <input
        ref={input} role="combobox" aria-label="搜索设置、Agent 或飞书群" aria-autocomplete="list"
        aria-controls="desktop-search-options" aria-expanded={open} aria-activedescendant={selected >= 0 ? `desktop-search-option-${selected}` : undefined}
        autoComplete="off" spellCheck={false} value={query}
        onChange={event => {setQuery(event.target.value); setActive(0);}}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'ArrowDown') {event.preventDefault(); setActive(index => Math.min(index + 1, results.length - 1));}
          if (event.key === 'ArrowUp') {event.preventDefault(); setActive(index => Math.max(index - 1, 0));}
          if (event.key === 'Home') {event.preventDefault(); setActive(0);}
          if (event.key === 'End') {event.preventDefault(); setActive(Math.max(0, results.length - 1));}
          if (event.key === 'Enter') {event.preventDefault(); choose();}
        }}
        placeholder="搜索设置、Agent 或飞书群…"
      />
      {query && <button className="desktop-search-clear" type="button" aria-label="清除搜索" onClick={() => {setQuery(''); setActive(0); input.current?.focus();}}><X size={15}/></button>}
      <kbd className="desktop-search-escape">esc</kbd>
    </div>
    <div className="desktop-search-section-heading">
      <span>{query.trim() ? '搜索结果' : '快速前往'}</span>
      <span role="status">{query.trim() ? `${results.length} 项` : ''}</span>
    </div>
    <div ref={resultList} className="desktop-search-results" id="desktop-search-options" role="listbox" aria-label="搜索结果">
      {results.map((entry, index) => <button
        key={entry.id} id={`desktop-search-option-${index}`} data-result-index={index} type="button" role="option"
        aria-selected={index === selected} className={`desktop-search-result${index === selected ? ' is-active' : ''}`}
        onMouseEnter={() => setActive(index)} onClick={() => onSelect(entry)}
      >
        <ResultIcon entry={entry}/>
        <span className="desktop-search-result-copy">
          <strong><Highlight text={entry.title} query={query}/></strong>
          <small>{entry.context}</small>
        </span>
        {entry.destination.guide && <span className="desktop-search-result-guide" aria-label="有使用条件">需先设置</span>}
        {index === selected && <ArrowRight className="desktop-search-result-arrow" size={15} aria-hidden="true"/>}
      </button>)}
      {query.trim() && results.length === 0 && <div className="desktop-search-empty"><Search size={22}/><strong>没有找到相关设置</strong><span>试试功能名称、Agent 名称或「飞书 Profile」。</span></div>}
    </div>
    <div className="desktop-search-footer"><span><kbd>↑</kbd><kbd>↓</kbd> 选择 <kbd>↵</kbd> 打开</span><span><Command size={12}/> K 搜索</span></div>
  </Dialog>;
}
