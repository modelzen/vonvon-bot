import { defineConfig } from 'tsup';

// SDK 保留运行时 import：桌面和独立 CLI 均在用户选择后安装到托管目录，
// 不将开发依赖打进产物。由 loadBackendDep 统一解析。
const external = ['@anthropic-ai/claude-agent-sdk'];

export default defineConfig([
  {
    entry: { cli: 'src/cli/index.ts' },
    outDir: 'dist',
    format: ['esm'],
    target: 'node20',
    platform: 'node',
    clean: true,
    sourcemap: false,
    splitting: false,
    dts: false,
    external,
  },
  {
    entry: { index: 'src/index.ts', host: 'src/host/public.ts' },
    outDir: 'dist',
    format: ['esm'],
    target: 'node20',
    platform: 'node',
    sourcemap: false,
    splitting: false,
    dts: true,
    external,
  },
]);
