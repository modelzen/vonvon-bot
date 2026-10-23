/** Only states needing attention get a mark; normal progress uses the existing timer. */
export type ProcessStatus = 'running' | 'completed' | 'failed' | 'stopped' | 'waiting' | 'unknown';

export function statusSymbol(status: ProcessStatus): string {
  if (status === 'running' || status === 'completed') return '';
  const marks: Record<Exclude<ProcessStatus, 'running' | 'completed'>, { symbol: string; color: string }> = {
    failed: { symbol: '×', color: 'red' },
    stopped: { symbol: '□', color: 'grey' },
    waiting: { symbol: 'Ⅱ', color: 'orange' },
    unknown: { symbol: '!', color: 'orange' },
  };
  const { symbol, color } = marks[status];
  return `<font color='${color}'>${symbol}</font>`;
}
