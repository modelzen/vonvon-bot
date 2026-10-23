/** A compact state mark shared by the main process and child steps. */
export type ProcessStatus = 'running' | 'completed' | 'failed' | 'stopped' | 'waiting' | 'unknown';

export function statusSymbol(status: ProcessStatus): string {
  const marks: Record<ProcessStatus, { symbol: string; color: string }> = {
    running: { symbol: '◌', color: 'blue' },
    completed: { symbol: '✓', color: 'green' },
    failed: { symbol: '×', color: 'red' },
    stopped: { symbol: '□', color: 'grey' },
    waiting: { symbol: 'Ⅱ', color: 'orange' },
    unknown: { symbol: '?', color: 'orange' },
  };
  const { symbol, color } = marks[status];
  return `<font color='${color}'>${symbol}</font>`;
}
