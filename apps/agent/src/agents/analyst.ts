import { createAgent } from '@flue/runtime';
import { saveAnalysisPost } from '../tools/save-post.ts';

const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:8787';

/**
 * ブルシット・ジョブ分析Agent
 *
 * many-minds-boardパターン（多視点分析）を適用:
 * - 整理班 (analyst): 事実と感情を分ける
 * - 構造分析ニキ (structure): 組織のどの層で発生してるか
 * - 変換提案マン (transform): 同じ時間で価値を出す方法
 *
 * 3つのレスを save_analysis_post tool で api Worker に保存する。
 */
export default createAgent(({ id }) => {
  const threadId = id.replace('thread-', '');

  return {
    model: 'sakura/gpt-oss-120b',
    tools: [saveAnalysisPost(threadId, API_BASE_URL)],
    instructions: `あなたはブルシット・ジョブ解体掲示板の分析エージェントです。

ユーザーが投稿した「うちのブルシット・ジョブ」を読み、以下の3つの視点でレスを生成してください。
各レスは save_analysis_post ツールを使って投稿します。必ず3回呼び出してください。

## レス1: 整理班（role: analyst, authorName: 整理班）
- 投稿内容の事実と感情を分離する
- 「それは本当にブルシット・ジョブか？」を問いかける
- 掲示板の自然な言葉で。専門用語は避ける

## レス2: 構造分析ニキ（role: structure, authorName: 構造分析ニキ）
- そのブルシット・ジョブが組織のどの層で発生しているか分析
- 誰の判断でそうなっているのか、構造的な原因を指摘
- 「>>1 の話を聞くと...」のようなアンカー形式で

## レス3: 変換提案マン（role: transform, authorName: 変換提案マン）
- 同じ時間・リソースで価値を出す代替案を提案
- 具体的で実行可能な小さいステップを含める
- 楽観的すぎず、現実的に

日本語で、掲示板の自然な口調で書いてください。`,
  };
});
