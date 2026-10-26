import {useEffect, useState} from 'react';
import type {DesktopSnapshot} from '@vonvon/protocol';
import {useClient} from './client-context';
import {Button, InlineNotice} from './reference/components/ui';
import {backgroundCount, migrationLines, pendingSharedCount, splitGroupCount, type MigrationFacts} from './migration-model';

const DISMISSED = 'vonvon.memory-migration-banner';
const dismissed = (): boolean => {try {return window.localStorage.getItem(DISMISSED) === '1';} catch {return false;}};

/** The one banner after a migration (§5.7): what became of the old groups, role files and memories. Gone once dismissed. */
export function MigrationBanner({snapshot}: {snapshot: DesktopSnapshot}) {
  const client = useClient();
  const [hidden, setHidden] = useState(dismissed);
  const [facts, setFacts] = useState<MigrationFacts>();
  const key = `${snapshot.agents.map(agent => agent.id).join(',')}|${(snapshot.projects ?? []).map(project => project.id).join(',')}`;
  useEffect(() => {
    if (hidden) return;
    let live = true;
    void (async () => {
      let rolesMerged = 0; let pendingShared = 0; let background = 0;
      for (const agent of snapshot.agents) {
        try {
          const settings = await client.settings({type: 'read', scope: {kind: 'agent', botId: agent.id}});
          if (settings.kind === 'view' && 'administrators' in settings.view && settings.view.roleInfo?.mergedNotice) rolesMerged++;
        } catch {/* a Bot that cannot be read adds nothing */}
        try {
          const memory = await client.memory({type: 'list', scope: {kind: 'bot', botId: agent.id}});
          if (memory.kind === 'list') pendingShared += pendingSharedCount(memory.items);
        } catch {/* same */}
      }
      for (const project of snapshot.projects ?? []) {
        try {
          const memory = await client.memory({type: 'list', scope: {kind: 'project', projectId: project.id}});
          if (memory.kind === 'list') background += backgroundCount(memory.items);
        } catch {/* same */}
      }
      if (live) setFacts({splitGroups: splitGroupCount(snapshot), rolesMerged, pendingShared, background});
    })();
    return () => {live = false;};
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, hidden, key]);
  const lines = facts && !hidden ? migrationLines(facts) : [];
  if (!lines.length) return null;
  return <InlineNotice title="升级后的变化" tone="neutral" actions={<Button size="sm" onClick={() => {try {window.localStorage.setItem(DISMISSED, '1');} catch {/* shown again next time */} setHidden(true);}}>知道了</Button>}>
    <ul className="migration-lines">{lines.map(line => <li key={line}>{line}</li>)}</ul>
  </InlineNotice>;
}
