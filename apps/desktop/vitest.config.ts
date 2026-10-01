import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '@common': resolve(__dirname, 'src/common') } },
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 20_000,
  },
});
