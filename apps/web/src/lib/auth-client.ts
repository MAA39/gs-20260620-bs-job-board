import { createAuthClient } from 'better-auth/client';
import { anonymousClient } from 'better-auth/client/plugins';

export const authClient = createAuthClient({
  baseURL: 'https://bs-job-board-api.masa-nekoshinshi39.workers.dev',
  plugins: [anonymousClient()],
});
