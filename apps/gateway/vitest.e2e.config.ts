import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/e2e/**/*.e2e.test.ts'],
    // Rocket.Chat boots slowly, and the suite drives a real server rather than
    // mocks; the default 5s timeout is not survivable here.
    testTimeout: 60_000,
    hookTimeout: 180_000,
    // The tests share one Rocket.Chat instance and mutate rooms in it.
    fileParallelism: false,
  },
});
