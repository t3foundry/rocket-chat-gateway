import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Unit tests only. The end-to-end suite needs a live Rocket.Chat and runs
    // from `vitest.e2e.config.ts`, so it must not be swept up here — CI runs
    // this job without any upstream server.
    include: ['src/**/*.test.ts'],
  },
});
