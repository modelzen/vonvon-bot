import { promises as fs } from 'node:fs';
import timers from 'node:timers/promises';
import { performance } from 'node:perf_hooks';

export async function promoteRuntimeStage(stage, destination) {
  const deadline = performance.now() + 10000;
  let retries = 0;
  for (;;) {
    try {
      await fs.rename(stage, destination);
      if (retries) console.warn(`Runtime staging rename recovered after ${retries} retries.`);
      return;
    } catch (error) {
      if (process.platform !== 'win32' || !['EPERM', 'EBUSY'].includes(error.code)) throw error;
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw error;
      if (!retries) console.warn(`Runtime staging rename returned ${error.code}; retrying for up to 10 seconds.`);
      await timers.setTimeout(Math.min(250, remaining));
      if (performance.now() >= deadline) throw error;
      retries++;
    }
  }
}
