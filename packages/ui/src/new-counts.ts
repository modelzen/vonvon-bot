import {useEffect, useState} from 'react';
import type {MemoryReply} from '@vonvon/protocol';
import {useClient} from './client-context';

export type NewCounts = {projects: Readonly<Record<string, number>>; bots: Readonly<Record<string, number>>};
export const noNewCounts: NewCounts = {projects: {}, bots: {}};
export const sumCounts = (counts: Readonly<Record<string, number>>): number => Object.values(counts).reduce((sum, count) => sum + count, 0);
/** "新 N", or nothing for 0 (§5.8). */
export const newTag = (count: number | undefined): string => count ? `新 ${count}` : '';
export const countsOf = (reply: MemoryReply): NewCounts => reply.kind === 'newCounts' ? {projects: reply.projects, bots: reply.bots} : noNewCounts;

/** How many entries are new on each project and Bot page (§5.8), read again when the snapshot moves or a page marked itself seen. */
export function useNewCounts(revision: number | undefined, seenEvent: string): NewCounts {
  const client = useClient();
  const [counts, setCounts] = useState<NewCounts>(noNewCounts);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const listener = () => setTick(value => value + 1);
    window.addEventListener(seenEvent, listener);
    return () => window.removeEventListener(seenEvent, listener);
  }, [seenEvent]);
  useEffect(() => {
    if (revision === undefined) return;
    let live = true;
    client.memory({type: 'newCounts'}).then(reply => {if (live) setCounts(countsOf(reply));}, () => {/* an older daemon or a read that failed shows no numbers */});
    return () => {live = false;};
  }, [client, revision, tick]);
  return counts;
}
