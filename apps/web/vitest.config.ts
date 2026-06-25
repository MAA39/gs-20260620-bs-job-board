import { defineConfig } from 'vitest/config';

export default defineConfig({
  // TanStack Start / Cloudflare プラグインは読み込まない
  plugins: [],
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
});
