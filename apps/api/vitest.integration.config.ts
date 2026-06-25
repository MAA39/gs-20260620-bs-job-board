import {
  cloudflareTest,
  readD1Migrations,
} from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig(async () => {
  const migrations = await readD1Migrations('migrations');

  return {
    plugins: [
      cloudflareTest({
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            INTERNAL_CALLBACK_KEY: 'test-callback-key-for-integration',
            BETTER_AUTH_SECRET: 'test-secret',
          },
          workers: [
            {
              name: 'bs-job-board-agent',
              modules: true,
              script:
                "export default { fetch: () => new Response(null, { status: 501 }) };",
            },
          ],
        },
        wrangler: {
          configPath: './wrangler.jsonc',
        },
      }),
    ],
    test: {
      include: ['src/**/*.integration.test.ts', 'src/**/*.unit.test.ts'],
      name: 'api-integration',
      setupFiles: ['src/apply-d1-migrations.integration.ts'],
    },
  };
});
