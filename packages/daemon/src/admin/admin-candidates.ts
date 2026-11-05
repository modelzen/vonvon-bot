import type { RefusedPerson } from '../bot/dm-refused';
import type { AdminCandidate } from './settings-types';

/** What the page shows for the creator when Feishu will not give their name. */
export const CREATOR_NAME = '创建者';

export interface CandidateInput {
  admins: readonly string[];
  /** `access.ownerOpenId`: who scanned the bot in, offered whether or not Feishu lists them */
  creator?: string;
  /** the application's owner, administrators and developers, as Feishu named them */
  feishu: readonly string[];
  refused: readonly RefusedPerson[];
  /** the names Feishu gave just now */
  names: ReadonlyMap<string, string>;
}

/**
 * Who may be picked as an administrator (dm-agent 3.4), the people already on the list left out. The creator is always
 * offered; someone Feishu names only counts when a name can be read, since an id alone tells the person choosing nothing;
 * a person turned away carries the name read when they were.
 */
export function adminCandidates(input: CandidateInput): AdminCandidate[] {
  const out = new Map<string, AdminCandidate>();
  const add = (openId: string, name: string, source: AdminCandidate['sources'][number], at?: number): void => {
    if (input.admins.includes(openId)) return;
    const found = out.get(openId);
    if (!found) { out.set(openId, { openId, name, sources: [source], ...(at === undefined ? {} : { at }) }); return; }
    found.sources.push(source);
    if (at !== undefined) found.at = at;
  };
  if (input.creator) add(input.creator, input.names.get(input.creator) ?? CREATOR_NAME, 'creator');
  for (const openId of new Set(input.feishu)) {
    const name = input.names.get(openId);
    if (name) add(openId, name, 'feishu');
  }
  for (const person of input.refused) add(person.openId, input.names.get(person.openId) ?? person.name, 'refused', person.at);
  return [...out.values()];
}
