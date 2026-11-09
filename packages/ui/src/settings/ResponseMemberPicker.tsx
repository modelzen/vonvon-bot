import {useState} from 'react';
import {RefreshCw} from 'lucide-react';
import {type ResponseRoster} from '@vonvon/protocol';
import {Button, IconButton, InlineNotice} from '../reference/components/ui';
import {Dialog} from '../reference/components/ui/Dialog';
import {PeopleRows, PeopleSearch, matchesPerson} from '../management/PeoplePicker';
import '../management/administrators.css';

export function ResponseMemberPicker({roster, selected, busy, readonly, message, onPick, onRefresh, onClose}: {
  roster?: ResponseRoster; selected: readonly string[];
  busy: boolean; readonly: boolean; message?: string; onPick: (id: string) => void; onRefresh: () => void; onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const match = query.trim().toLocaleLowerCase();
  const available = roster?.entries.filter(person => !selected.includes(person.openId)) ?? [];
  const candidates = available.filter(person => matchesPerson(person, query));
  return <Dialog open size="md" title="指定成员" onClose={busy ? undefined : onClose} footer={<Button disabled={busy} onClick={onClose}>完成</Button>}>
    <div className="admin-dialog">
      <PeopleSearch label="搜索群成员" query={query} onChange={setQuery}/>
      <div className="response-member-picker-heading"><h3>本群成员</h3><IconButton size="sm" variant="ghost" label="重新读取成员" title="重新读取成员" disabled={busy} onClick={onRefresh}><RefreshCw size={15} strokeWidth={1.7}/></IconButton></div>
      {roster?.state !== 'complete' && <p className="admin-empty">成员列表尚未完整读取，已选成员保留。可以重新读取。</p>}
      <PeopleRows label="群成员" people={candidates.map(person => ({...person,tag:person.kind === 'bot' ? 'Bot' : undefined}))} disabled={readonly || busy} onPick={onPick}
        empty={match ? '没有匹配的成员。' : roster?.entries.length ? '本群已读取的成员都已添加。' : '暂时没有读到群成员。'}/>
      {message && <InlineNotice title="成员范围" tone="info">{message}</InlineNotice>}
    </div>
  </Dialog>;
}
