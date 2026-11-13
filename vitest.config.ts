import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Tests import workspace packages from their source, so they run without a build step.
const source = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

const workspacePackages: Record<string, string> = {
  types: 'packages/types',
  testing: 'packages/testing',
  engine: 'packages/engine',
  cli: 'packages/cli',
  'source-fake': 'packages/sources/fake',
  'source-whatsapp': 'packages/sources/whatsapp',
  'source-zalo': 'packages/sources/zalo',
  'sink-margince': 'packages/sinks/margince',
  'sink-archive': 'packages/sinks/archive',
};

export default defineConfig({
  // The verification cage mounts node_modules read-only; TMPDIR is writable.
  cacheDir: path.join(os.tmpdir(), 'chat-bridge-vite'),
  resolve: {
    alias: [
      {
        find: /^@chat-bridge\/testing\/scenarios\/scenario-builder\.js$/,
        replacement: source('./packages/testing/src/scenarios/scenario-builder.ts'),
      },
      ...Object.entries(workspacePackages).map(([name, dir]) => ({
        find: new RegExp(`^@chat-bridge/${name}$`),
        replacement: source(`./${dir}/src/index.ts`),
      })),
    ],
  },
  test: {
    globals: true,
    environment: 'node',
    reporters: ['default'],
    include: ['packages/**/*.{test,spec}.ts', 'guards/**/*.{test,spec}.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 85,
        statements: 90,
      },
    },
  },
});

