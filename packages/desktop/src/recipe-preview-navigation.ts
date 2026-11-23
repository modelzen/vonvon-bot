import { randomUUID } from 'node:crypto';
import { draftPreviewLocatorSchema, draftPreviewNavigationIdSchema, type DraftPreviewLocator, type DraftPreviewNavigation } from '@vonvon/protocol';

export type RecipePreviewScheme = 'vonvon' | 'vonvon-preview';
const route = /^([a-z-]+):\/\/recipes\/drafts\/([a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12})\?revision=([1-9][0-9]{0,15})$/;

export function parseDraftPreview(raw: unknown, scheme: RecipePreviewScheme): DraftPreviewLocator | undefined {
  if (typeof raw !== 'string') return;
  const match = route.exec(raw);
  if (!match || match[0] !== raw || match[1] !== scheme) return;
  const parsed = draftPreviewLocatorSchema.safeParse({draftId: match[2].toLowerCase(), revision: Number(match[3])});
  return parsed.success ? parsed.data : undefined;
}

export class RecipePreviewNavigation {
  private readonly queue = new Map<string, DraftPreviewNavigation>();
  private readonly listeners = new Set<(navigation: DraftPreviewNavigation) => void>();
  constructor(private readonly scheme: RecipePreviewScheme) {}

  open(raw: unknown): boolean {
    const locator = parseDraftPreview(raw, this.scheme);
    if (!locator) return false;
    return this.request(locator);
  }

  request(input: DraftPreviewLocator, accountId?: string): boolean {
    const locator = draftPreviewLocatorSchema.parse(input);
    const existing = this.pending().find(value => value.draftId === locator.draftId && value.revision === locator.revision && value.accountId === accountId);
    const navigation = existing ?? {...locator, ...(accountId && {accountId}), navigationId: randomUUID()};
    if (!existing) this.queue.set(navigation.navigationId, navigation);
    for (const listener of this.listeners) listener({...navigation});
    return true;
  }

  pending(): DraftPreviewNavigation[] { return Array.from(this.queue.values(), value => ({...value})); }
  retainAccount(accountId?: string): void {
    for (const [id, navigation] of this.queue) if (navigation.accountId && navigation.accountId !== accountId) this.queue.delete(id);
  }
  acknowledge(navigationId: string, accountId?: string): void {
    const id = draftPreviewNavigationIdSchema.parse(navigationId), owner = this.queue.get(id)?.accountId;
    if (!owner || owner === accountId) this.queue.delete(id);
  }
  onOpen(listener: (navigation: DraftPreviewNavigation) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
}

export interface RecipePreviewLaunchEvents {
  onOpenUrl(listener: (event: {preventDefault(): void}, url: string) => void): void;
  onSecondInstance(listener: (argv: string[]) => void): void;
  argv: readonly string[];
  reveal(): void;
}

export function captureRecipePreviewLaunches(navigation: RecipePreviewNavigation, events: RecipePreviewLaunchEvents): void {
  events.onOpenUrl((event, url) => {
    if (navigation.open(url)) { event.preventDefault(); events.reveal(); }
  });
  events.onSecondInstance(argv => {
    for (const value of argv) navigation.open(value);
    events.reveal();
  });
  for (const value of events.argv) if (navigation.open(value)) events.reveal();
}
