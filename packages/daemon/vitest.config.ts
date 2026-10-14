import { defineConfig } from 'vitest/config';

// Real-process cases needed 20 to 60 s on Windows CI and over the 5 s default on macOS and Linux (CI census, 2026-10-13/14).
const timeout = process.platform === 'win32' ? 60_000 : 20_000;

export default defineConfig({
  test: {
    testTimeout: timeout,
    hookTimeout: timeout,
    maxWorkers: process.platform === 'win32' && process.env.CI === 'true' ? 1 : undefined,
    // Only our own unit tests. Without this, vitest also scans the vendored
    // reference project under docs/references/** (yepanywhere etc.), which has
    // its own deps/runtime and fails to collect.
    include: ['test/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**', 'docs/**', 'prototype/**'],
  },
});
