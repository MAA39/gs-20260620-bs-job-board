import type { CreatePostInput } from '@bs-job-board/contracts';

/**
 * Flue Agent 用 tool: api Worker を呼んでAI分析レスを保存する。
 * gs-20260619 の postComment パターンの延長。
 */
export function saveAnalysisPost(threadId: string, apiBaseUrl: string) {
  return {
    name: 'save_analysis_post',
    description: 'ブルシット・ジョブのスレッドにAI分析レスを保存する。role, authorName, body を指定して呼ぶ。',
    parameters: {
      type: 'object' as const,
      properties: {
        role: {
          type: 'string',
          enum: ['analyst', 'structure', 'transform'],
          description: 'レスの役割。analyst=事実整理、structure=構造分析、transform=変換提案',
        },
        authorName: {
          type: 'string',
          description: 'レスの投稿者名（例: 整理班、構造分析ニキ、変換提案マン）',
        },
        body: {
          type: 'string',
          description: 'レスの本文',
        },
      },
      required: ['role', 'authorName', 'body'],
    },
    execute: async (args: { role: string; authorName: string; body: string }) => {
      const input: CreatePostInput = {
        author_type: 'ai',
        author_name: args.authorName,
        role: args.role as CreatePostInput['role'],
        body: args.body,
      };

      const response = await fetch(`${apiBaseUrl}/api/v1/threads/${threadId}/posts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });

      if (!response.ok) {
        throw new Error(`API error: ${response.status} ${await response.text()}`);
      }

      const result = await response.json();
      return `レス #${result.post_number} を投稿しました（${args.authorName}）`;
    },
  };
}
