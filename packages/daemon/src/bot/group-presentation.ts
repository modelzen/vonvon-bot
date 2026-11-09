import type { AppConfig } from '../config/schema';
import type { Project } from '../project/registry';

/** A run-local snapshot with fixed native display defaults when no local card style is set. */
export function presentationConfig(cfg: AppConfig, project?: Pick<Project, 'presentation'>): AppConfig {
  const value = project?.presentation;
  // The old Bot field is migration-only: even an unmaterialized row means the
  // fixed native default, never a live inheritance from the Bot.
  const {cardDisplay: _legacy,showToolCalls: _oldTools,showModel: _oldModel, ...other}=cfg.preferences ?? {};
  const {template:_botTemplate,...completion}=cfg.preferences?.completionReminder ?? {};
  const preferences={...other,...(cfg.preferences?.completionReminder ? {completionReminder:completion} : {}),showToolCalls:true,showModel:'running' as const};
  if (!value) return { ...cfg, preferences };
  return { ...cfg, preferences: { ...preferences,
    ...(value.voiceEnabled === undefined ? {} : {voice: { ...cfg.preferences?.voice, enabled: value.voiceEnabled }}),
    // Historical per-chat toggles are captured in cardDisplay during migration.
    // An explicit null is a reset to the fixed native presentation.
    showToolCalls: true,
    showModel: 'running',
    cardDisplay: value.cardDisplay ?? undefined,
    ...(value.completionMode === undefined && value.longTaskMinutes === undefined && value.completionTemplate == null ? {} : {completionReminder: {
      ...completion,
      ...(value.completionMode === undefined ? {} : {mode:value.completionMode}),
      ...(value.longTaskMinutes === undefined ? {} : {longTaskMinutes:value.longTaskMinutes}),
      ...(value.completionTemplate == null ? {} : {template:value.completionTemplate}),
    }}),
  } };
}
