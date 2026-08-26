import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: { '@warrant/core': resolve(__dirname, '../../packages/core/src') },
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // The integration tests share one Postgres database; running files in parallel
    // makes them fight over the same rows. Correctness over wall-clock here.
    fileParallelism: false,
    testTimeout: 20000,
  },
});
