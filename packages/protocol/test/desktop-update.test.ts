import {expect, it} from 'vitest';
import {desktopUpdateSchema} from '../src/machine.js';

const update = {state: 'available', current: '0.7.8', latest: '0.7.9', message: ''};
it('keeps older update replies compatible and preserves measured progress and release notes', () => {
  expect(desktopUpdateSchema.parse(update)).toEqual(update);
  const withProgress = {...update, releaseNotes: '改进 Windows 升级', downloadProgress: {percent: 42.9, transferred: 429, total: 1000}};
  expect(desktopUpdateSchema.parse(withProgress)).toEqual(withProgress);
});

it('rejects malformed progress and oversized release text at the IPC boundary', () => {
  for (const progress of [
    {percent: -1, transferred: 0, total: 100},
    {percent: 101, transferred: 101, total: 100},
    {percent: NaN, transferred: 0, total: 100},
    {percent: 0, transferred: -1, total: 100},
    {percent: 0, transferred: 0, total: Infinity},
  ]) expect(desktopUpdateSchema.safeParse({...update, downloadProgress: progress}).success).toBe(false);
  expect(desktopUpdateSchema.safeParse({...update, releaseNotes: 'x'.repeat(4097)}).success).toBe(false);
});
