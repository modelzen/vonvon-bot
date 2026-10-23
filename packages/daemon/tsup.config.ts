import { defineConfig } from 'tsup';

// SDK 保留运行时 import：桌面包在 Resources/daemon 内置完整依赖，
// 独立 CLI 仍可按需安装到用户目录。由 loadBackendDep 统一解析。
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
