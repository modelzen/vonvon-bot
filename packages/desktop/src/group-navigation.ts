import {randomUUID} from 'node:crypto';
import {parseGroupConfigurationLink, groupNavigationIdSchema, type GroupConfigurationLocator, type GroupConfigurationNavigation} from '@vonvon/protocol';
import type {RecipePreviewScheme, RecipePreviewLaunchEvents} from './recipe-preview-navigation.js';

export function parseGroupConfiguration(raw: unknown, scheme: RecipePreviewScheme): GroupConfigurationLocator | undefined {
  const locator = parseGroupConfigurationLink(raw);
  return locator?.scheme === scheme ? {botAppId: locator.botAppId, groupId: locator.groupId} : undefined;
}

export class GroupNavigation {
  private readonly queue = new Map<string, GroupConfigurationNavigation>();
  private readonly listeners = new Set<(navigation: GroupConfigurationNavigation) => void>();
  constructor(private readonly scheme: RecipePreviewScheme) {}
  open(raw: unknown): boolean {
    const locator = parseGroupConfiguration(raw, this.scheme);
    if (!locator) return false;
    const existing = this.pending().find(value => value.botAppId === locator.botAppId && value.groupId === locator.groupId);
    const navigation = existing ?? {...locator, navigationId: randomUUID()};
    if (!existing) this.queue.set(navigation.navigationId, navigation);
    for (const listener of this.listeners) listener({...navigation});
    return true;
  }
  pending(): GroupConfigurationNavigation[] { return Array.from(this.queue.values(), value => ({...value})); }
  acknowledge(navigationId: string): void { this.queue.delete(groupNavigationIdSchema.parse(navigationId)); }
  onOpen(listener: (navigation: GroupConfigurationNavigation) => void): () => void {
    this.listeners.add(listener);
    return () => {this.listeners.delete(listener);};
  }
}

export function captureGroupLaunches(navigation: GroupNavigation, events: RecipePreviewLaunchEvents): void {
  events.onOpenUrl((event, url) => {
    if (navigation.open(url)) {event.preventDefault(); events.reveal();}
  });
  events.onSecondInstance(argv => {
    for (const value of argv) if (navigation.open(value)) events.reveal();
  });
  for (const value of events.argv) if (navigation.open(value)) events.reveal();
}
