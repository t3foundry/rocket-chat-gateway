import { defineConfig } from 'tsup';

export default defineConfig((options) => ({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  // Not while watching: `turbo dev` starts every package's watcher at once,
  // and wiping `dist/` here empties it under the gateway's already-running
  // compiler, which then reports the whole API surface as implicitly `any`.
  clean: !options.watch,
  treeshake: true,
  target: 'es2023',
  external: ['@open-rocket-chat/api-contract', '@open-rocket-chat/rc-rest-client'],
}));
