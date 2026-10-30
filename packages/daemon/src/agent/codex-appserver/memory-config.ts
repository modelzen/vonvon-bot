/** All model-bearing and prewarm threads must bypass global memory machinery. */
export const NATIVE_MEMORY_OFF = {
  features: { memories: false },
  memories: { use_memories: false, generate_memories: false },
};

/** Codex's own automations stay off: vonvon's scheduler owns scheduling (定时任务总设计 9.2). */
export const NATIVE_SCHEDULING_OFF = {
  features: { in_app_local_automation: false },
};
