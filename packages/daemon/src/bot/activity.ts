import { randomUUID } from 'node:crypto';
import type { BotActivity } from '@vonvon/protocol';
import type { AgentEvent, ToolKind } from '../agent/types';
import { reportActivity, reportActivityEnded } from './diagnostics';

const HEARTBEAT_MS = 15_000;
const TOOL_LIMIT = 1024;
type Phase = BotActivity['phase'];

/** One run's content-free activity. Never derive thinking from silence or a card footer. */
export function createRunActivity(groupId: string, options: { now?: () => number } = {}) {
  const now = options.now ?? Date.now;
  const id = randomUUID();
  const startedAt = now();
  const tools = new Map<string, ToolKind>();
  let phase: Phase = 'processing';
  let waiting = false;
  let compacting = false;
  let active = true;
  let closed = false;
  let failed = false;
  let latest: BotActivity | undefined;
  let signature = '';

  function publish(heartbeat = false): void {
    if (closed || !active) return;
    const visiblePhase = waiting ? 'waiting' : compacting ? 'compacting' : tools.size ? 'tool' : phase;
    const kinds = [...tools.values()];
    const toolKind = kinds.length && kinds.every(kind => kind === kinds[0]) ? kinds[0]! : 'tool';
    const nextSignature = `${visiblePhase}:${tools.size}:${toolKind}`;
    if (nextSignature !== signature || !latest) {
      signature = nextSignature;
      latest = { id, groupId, phase: visiblePhase, startedAt, updatedAt: now(),
        ...(tools.size ? { activeToolCount: tools.size, toolKind } : {}) };
      reportActivity(latest);
    } else if (heartbeat) reportActivity(latest);
  }
  function clear(): void {
    if (!active) return;
    active = false;
    latest = undefined;
    signature = '';
    reportActivityEnded(id);
  }
  function addTool(key: string, kind: ToolKind = 'tool'): void {
    if (tools.has(key) || tools.size < TOOL_LIMIT) tools.set(key, kind);
    active = true;
    phase = 'processing';
  }
  const heartbeat = setInterval(() => publish(true), HEARTBEAT_MS);
  heartbeat.unref?.();
  publish();
  return {
    /** Structural changes publish immediately; repeated text/reasoning tokens do not. */
    accept(event: AgentEvent): void {
      if (closed || failed) return;
      switch (event.type) {
        case 'turn_started': active = true; phase = 'processing'; break;
        case 'thinking_delta': active = true; phase = 'thinking'; break;
        case 'text_delta': active = true; phase = 'responding'; break;
        // A completed block is evidence that the stage ended, not that it started.
        case 'thinking': if (phase === 'thinking') phase = 'processing'; break;
        case 'text': if (phase === 'responding') phase = 'processing'; break;
        case 'tool_use': addTool(`parent:${event.itemId}`, event.kind); break;
        case 'tool_result': tools.delete(`parent:${event.itemId}`); break;
        case 'subagent_step':
          if (event.status === 'running') addTool(`child:${JSON.stringify(event.id)}:${event.stepId}`, event.kind);
          else tools.delete(`child:${JSON.stringify(event.id)}:${event.stepId}`);
          break;
        case 'subagent_status':
          if (event.status !== 'running') for (const key of tools.keys()) if (key.startsWith(`child:${JSON.stringify(event.id)}:`)) tools.delete(key);
          break;
        case 'compaction': active = true; compacting = event.phase === 'start'; phase = 'processing'; break;
        case 'error':
          if (!event.willRetry) { failed = true; tools.clear(); waiting = false; compacting = false; clear(); return; }
          tools.clear(); compacting = false; active = true; phase = 'retrying'; break;
        case 'done':
          // Goal children may outlive a parent turn. Keep their real tools/wait
          // visible; the next turn_started resumes the same run identity.
          for (const key of tools.keys()) if (key.startsWith('parent:')) tools.delete(key);
          compacting = false; phase = 'processing';
          if (!waiting && !tools.size) { clear(); return; }
          break;
        case 'awaiting_subagents': phase = 'processing'; break;
        default: return;
      }
      publish();
    },
    /** The ask broker's current wait, including successful answers/cancellations. */
    waiting(value: boolean): void {
      if (closed || failed) return;
      waiting = value;
      if (value) active = true;
      publish();
    },
    end(): void {
      if (closed) return;
      clear();
      closed = true;
      tools.clear();
      clearInterval(heartbeat);
    },
  };
}
