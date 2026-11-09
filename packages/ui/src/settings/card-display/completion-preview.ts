import {renderCompletionTemplate} from '@vonvon/protocol';
import type {CompletionReminderDraft} from './card-display-model';

// Matches the terminal RunState in the generated native card fixtures.
export const PREVIEW_RUN_DURATION_MS = 9_000;
export function completionPreviewText(reminder: CompletionReminderDraft, state: {done: boolean; requested: boolean; streamText: boolean}): string | undefined {
  if (!state.done) return;
  const show = reminder.completionMode === 'always'
    || reminder.completionMode === 'manual' && state.streamText && state.requested
    || reminder.completionMode === 'long' && PREVIEW_RUN_DURATION_MS >= reminder.longTaskMinutes * 60_000;
  // This demo completes successfully; failures-only notifications do not fire.
  if (!show) return;
  try {
    return renderCompletionTemplate(reminder.completionTemplate, {task:'介绍 Vonvon Bot',elapsed:'9 秒',status:'已完成',icon:'✅',durationLabel:'用时',detail:'结果在上方卡片。'});
  } catch {return;}
}
