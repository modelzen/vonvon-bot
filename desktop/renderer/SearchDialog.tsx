import {useEffect, useRef, useState} from 'react';
import {Dialog} from './reference/components/ui/Dialog';
import {findEntries, type SearchEntry} from './search';

export function SearchDialog({open, entries, onClose, onSelect}: {
  open: boolean; entries: SearchEntry[]; onClose: () => void; onSelect: (entry: SearchEntry) => void;
}) {
  const [query, setQuery] = useState('');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {if (!open) setQuery('');}, [open]);
  const results = findEntries(entries, query);
  return <Dialog open={open} title="搜索" onClose={onClose} initialFocusRef={input}>
    <input ref={input} aria-label="搜索设置、Agent 或项目" className="settings-field" type="search" value={query} onChange={event => setQuery(event.target.value)}
      placeholder="搜索设置、Agent 或项目" onKeyDown={event => {if (event.key === 'Enter' && results[0]) onSelect(results[0]);}} />
    <div className="desktop-search-results" aria-label="搜索结果">
      {results.map(entry => <button className="settings-entity-row" key={entry.id} onClick={() => onSelect(entry)}>
        <span className="settings-entity-row__copy"><strong>{entry.title}</strong><small>{entry.context}</small></span>
      </button>)}
      {query.trim() && !results.length && <p role="status">没有找到匹配项。</p>}
      {!query.trim() && <p>可按名称、工作目录或设置关键词查找。</p>}
    </div>
  </Dialog>;
}
