import type { SettingsCommitOptions } from './settings-types';
import type { JoinedGroups } from './groups';

/** Transport-independent operations shared by the terminal and bot tool adapters. */
export async function settingsGet<Scope, View>(service: { read(scope: Scope): Promise<View> }, scope: Scope) {
  return { view: await service.read(scope) };
}
export function settingsSet<Edit, Result>(service: { save(edit: Edit, options?: SettingsCommitOptions): Promise<Result> }, edit: Edit, options?: SettingsCommitOptions) {
  return service.save(edit, options);
}
export interface FeishuMembers { members: { openId: string; name: string }[]; nextCursor?: string }
export function feishuGroups(service: { groups(cursor?: string): Promise<JoinedGroups> }, cursor?: string) {
  return service.groups(cursor);
}
export function feishuMembers(service: { members(chatId: string, cursor?: string): Promise<FeishuMembers> }, chatId: string, cursor?: string) {
  return service.members(chatId, cursor);
}

export async function settingsAccess<Scope, View extends { sections: Record<string, { access: unknown } | undefined> }>(service: { read(scope: Scope): Promise<View> }, scope: Scope) {
  const { view } = await settingsGet(service, scope);
  return { access: Object.fromEntries(Object.entries(view.sections).flatMap(([name, section]) => section ? [[name, section.access]] : [])) };
}
