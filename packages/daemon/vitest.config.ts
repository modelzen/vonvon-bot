import { defineConfig } from 'vitest/config';

// Real-process cases needed up to 60 s on the Windows CI runner and more than the vitest 5 s default on macOS and
// Linux. Hooks get less than tests on Windows: a hook still waiting at 30 s holds a leaked process, not a slow one.
const win32 = process.platform === 'win32';

export default defineConfig({
  test: {
    testTimeout: win32 ? 60_000 : 20_000,
    hookTimeout: win32 ? 30_000 : 20_000,
    maxWorkers: process.platform === 'win32' && process.env.CI === 'true' ? 1 : undefined,
    // Only our own unit tests. Without this, vitest also scans the vendored
    // reference project under docs/references/** (yepanywhere etc.), which has
    // its own deps/runtime and fails to collect.
    include: ['test/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**', 'docs/**', 'prototype/**'],
  },
});
