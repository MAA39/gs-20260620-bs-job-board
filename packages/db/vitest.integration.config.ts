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
          },
          workers: [
            {
              name: 'bs-job-board-agent',
              modules: true,
              script:
                "export default { fetch() { return new Response(null, { status: 501 }); } };",
            },
          ],
        },
        wrangler: {
          configPath: '../../apps/api/wrangler.jsonc',
        },
      }),
    ],
    test: {
      include: ['src/**/*.integration.test.ts'],
      name: 'db-integration',
      setupFiles: ['src/apply-d1-migrations.integration.ts'],
    },
  };
});
