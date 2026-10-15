import {useEffect, useState} from 'react';
import type {ToolState} from '@vonvon/protocol';
import {useClient} from '../client-context';

/** Once per window: each ask starts a ~250 MB Claude CLI. */
let asked = false;

/** The checklist's and the 状态与诊断 page's Claude login check. The snapshot only carries a cached answer,
 * so with Claude installed and no answer this asks once; `checking` covers the render before that ask
 * too, so the row says 检查中 rather than 无法确认 until the answer is in. */
export function useClaudeLoginCheck(tools: readonly ToolState[], onError: (message: string) => void) {
  const client = useClient();
  // A count, not a flag: the automatic check and a click can overlap.
  const [checks, setChecks] = useState(0);
  const claude = tools.find(tool => tool.tool === 'claude');
  const waiting = claude?.installation === 'installed' && claude.authentication === 'unknown';
  async function check(refresh: boolean) {
    setChecks(count => count + 1);
    // The daemon rebuilds the snapshot before it replies, so the row follows it.
    try { await client.environment({type: 'backendLogin', id: 'claude-agent', refresh}); }
    catch (error) { onError(error instanceof Error ? error.message : '暂时无法检查 Claude 登录。'); }
    finally { setChecks(count => count - 1); }
  }
  useEffect(() => {
    if (asked || !waiting) return;
    asked = true;
    void check(false);
  }, [waiting]);
  return {checking: checks > 0 || (waiting && !asked), check};
}
