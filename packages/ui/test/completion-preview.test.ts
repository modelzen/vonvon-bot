import {expect,it} from 'vitest';
import {completionPreviewText} from '../src/settings/card-display/completion-preview';
import {defaultCompletionReminder} from '../src/settings/card-display/card-display-model';

const done = {done:true,requested:false,streamText:true};
it('shows automatic notifications only after the real demo duration qualifies',()=>{
  expect(completionPreviewText({...defaultCompletionReminder(),completionMode:'always'},{...done,done:false})).toBeUndefined();
  expect(completionPreviewText({...defaultCompletionReminder(),completionMode:'always'},done)).toContain('用时 9 秒');
  expect(completionPreviewText({...defaultCompletionReminder(),completionMode:'long',longTaskMinutes:1},done)).toBeUndefined();
  expect(completionPreviewText(defaultCompletionReminder(),done)).toBeUndefined();
});
it('requires a manual click in a streaming run and uses the edited reminder copy',()=>{
  const reminder = {...defaultCompletionReminder(),completionMode:'manual' as const,completionTemplate:'{{statusIcon}} 花了 {{elapsed}}，快来看看成果吧！'};
  expect(completionPreviewText(reminder,done)).toBeUndefined();
  expect(completionPreviewText(reminder,{...done,requested:true})).toBe('✅ 花了 9 秒，快来看看成果吧！');
  expect(completionPreviewText(reminder,{...done,requested:true,streamText:false})).toBeUndefined();
});
