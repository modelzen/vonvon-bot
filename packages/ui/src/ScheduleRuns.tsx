import {useState} from 'react';
import {ArrowUpRight} from 'lucide-react';
import {formatTime, formatUptime, type ScheduledTaskView, type ScheduleRunRecord} from '@vonvon/protocol';
import {useShellCapabilities} from './client-context';
import {Button, InlineNotice} from './reference/components/ui';
import {openExternalUrl} from './url-actions';
import {runStatusText, scheduleRunLink, shownZone} from './schedule-model';

function runText(record: ScheduleRunRecord): string {
  const count = record.count && record.count > 1 ? ` ${record.count} 次` : '';
  const trigger = record.trigger === 'manual' ? '（手动运行）' : record.trigger === 'catchUp' ? '（补跑）' : '';
  return `${runStatusText[record.status]}${count}${trigger}${record.error ? `：${record.error}` : ''}`;
}

/** An opened task: its counts, its last 20 runs newest first, and the start of its last result. Times are in the same zone as its row. */
export function ScheduleRuns({task, hostZone, now}: {task: ScheduledTaskView; hostZone: string; now?: number}) {
  const shell = useShellCapabilities();
  const [error, setError] = useState('');
  const runs = [...task.recent].reverse();
  const timeZone = shownZone(task.timeZone, hostZone);
  return <div className="schedule-runs">
    <p className="group-control-note">共运行 {task.counts.runs} 次 · 错过 {task.counts.missed} 次 · 跳过 {task.counts.skipped} 次</p>
    {runs.length ? <table>
      <thead><tr><th scope="col">时间</th><th scope="col">状态</th><th scope="col">用时</th><th scope="col"><span className="visually-hidden">链接</span></th></tr></thead>
      <tbody>{runs.map(record => {
        const link = scheduleRunLink(record, task.chatId);
        return <tr key={record.runId}>
          <td>{formatTime(record.startedAt ?? record.slot, {timeZone, now})}</td>
          <td>{runText(record)}</td>
          <td>{record.durationMs === undefined ? '—' : formatUptime(record.durationMs)}</td>
          <td>{link && <Button size="sm" variant="ghost" onClick={() => void openExternalUrl(link, 'group', shell).catch(failure => setError(failure instanceof Error ? failure.message : '无法打开飞书。'))}>在飞书打开<ArrowUpRight size={12} aria-hidden="true"/></Button>}</td>
        </tr>;
      })}</tbody>
    </table> : <p className="group-control-note">还没有运行记录。</p>}
    {task.lastResult?.excerpt && <section aria-label="最近一次结果"><h4>最近一次结果</h4><p>{task.lastResult.excerpt}</p></section>}
    {error && <InlineNotice title="打不开飞书" tone="warning">{error}</InlineNotice>}
  </div>;
}
