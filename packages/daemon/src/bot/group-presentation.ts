import type { AppConfig } from '../config/schema';
import { getModelDisplay } from '../config/schema';
import type { Project } from '../project/registry';

/** A run-local snapshot. Old rows keep legacy behavior until settings are materialized. */
export function presentationConfig(cfg: AppConfig, project?: Pick<Project, 'presentation'>): AppConfig {
  const value = project?.presentation;
  if (!value) return cfg;
  return { ...cfg, preferences: { ...cfg.preferences,
    voice: { ...cfg.preferences?.voice, enabled: value.voiceEnabled },
    showToolCalls: value.showToolCalls,
    showModel: value.showModel ?? getModelDisplay(cfg),
    completionReminder: { mode: value.completionMode, longTaskMinutes: value.longTaskMinutes },
  } };
}
