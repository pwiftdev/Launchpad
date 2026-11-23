import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Same "@/..." alias as tsconfig.json
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    include: ['src/**/*.test.ts'],
    // Embedded PostgreSQL and signer subprocesses need bounded startup concurrency.
    maxWorkers: 4,
  },
});
