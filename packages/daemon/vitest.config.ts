import { defineConfig } from 'vitest/config';
import { availableParallelism } from 'node:os';

// Real-process cases needed up to 60 s on the Windows CI runner and more than the vitest 5 s default on macOS and
// Linux. Hooks get less than tests on Windows: a hook still waiting at 30 s holds a leaked process, not a slow one.
const win32 = process.platform === 'win32';
const linuxCI = process.platform === 'linux' && process.env.CI === 'true';

export default defineConfig({
  test: {
    testTimeout: win32 ? 60_000 : 20_000,
    hookTimeout: win32 ? 30_000 : 20_000,
    // Many files launch several real provider/daemon children. Bound file-level
    // parallelism so their readiness checks do not compete with dozens of peers;
    // each test still exercises its own full process/concurrency behavior.
    // A two-CPU Linux CI runner should use two workers rather than serializing
    // every file. Keep the four-worker cap and local CPU-minus-one behavior.
    maxWorkers: win32 ? (process.env.CI === 'true' ? 1 : undefined) : Math.min(4, Math.max(1, availableParallelism() - (linuxCI ? 0 : 1))),
    // Only our own unit tests. Without this, vitest also scans the vendored
    // reference project under docs/references/** (yepanywhere etc.), which has
    // its own deps/runtime and fails to collect.
    include: ['test/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**', 'docs/**', 'prototype/**'],
  },
});
