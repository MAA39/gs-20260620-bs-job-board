import { createAgent, type FlueContext, type WorkflowRouteHandler } from '@flue/runtime';

// HTTP公開する（workflowのroute export）
export const route: WorkflowRouteHandler = async (_c, next) => next();

const replier = createAgent(() => ({
  model: 'sakura/gpt-oss-120b',
}));

export async function run({ init, payload }: FlueContext) {
  const { threadTitle, body } = payload as { threadTitle: string; body: string };

  const harness = await init(replier);
  const session = await harness.session();
  const response = await session.prompt(
    `あなたは2chふう匿名掲示板の住民です。判断しない。材料を並べる。
スレタイ: ${threadTitle}
投稿: ${body}
掲示板住民として自然に反応してください。`,
  );

  return { reply: response.text };
}
