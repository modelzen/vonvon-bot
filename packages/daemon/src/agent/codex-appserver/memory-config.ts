/** All model-bearing and prewarm threads must bypass global memory machinery. */
export const NATIVE_MEMORY_OFF = {
  features: { memories: false },
  memories: { use_memories: false, generate_memories: false },
};

/** Codex's own automations stay off: vonvon's scheduler owns scheduling (定时任务总设计 9.2). */
export const NATIVE_SCHEDULING_OFF = {
  features: { in_app_local_automation: false },
};

const closedTools = (...names: string[]) => ({ tools: Object.fromEntries(names.map(name => [name, { enabled: false }])) });

/**
 * ChatGPT connector tools that schedule work on ChatGPT's side, where vonvon cannot see, pause or stop it (定时任务 T3b).
 * Only these tools close; the apps and their other tools stay (product.md section 9 item 19). Names as `app/read` lists
 * them on Codex 0.163.0; `features.in_app_local_automation` does not reach them.
 */
export const CONNECTOR_SCHEDULING_OFF = {
  apps: {
    // ChatGPT Space: page automations, and page auto-update (re-runs a page on a schedule).
    connector_openai_pages: closedTools('list_page_automations', 'create_controller_automation', 'attach_automation_to_page',
      'get_page_auto_update', 'set_page_auto_update', 'run_page_auto_update'),
    // Sites: a site's scheduled cloud task.
    connector_20205bf7d4e99a89d7154bb849718324: closedTools('create_schedule', 'validate_suggested_schedule'),
  },
};
