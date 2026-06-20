import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { threadRoutes } from './routes/threads.ts';

type Bindings = {
  DB: D1Database;
  SAKURA_API_TOKEN: string;
};

const app = new Hono<{ Bindings: Bindings }>();
app.use('/api/*', cors());
app.get('/health', (c) => c.json({ status: 'ok' }));
app.route('/api/v1/threads', threadRoutes);

export default app;
export type AppType = typeof app;

// デバッグ: AIの生レスポンスを全部見るページ
app.get('/debug', (c) => {
  return c.html(`<!DOCTYPE html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AI Debug</title>
<style>
* { margin:0; padding:0; box-sizing:border-box; }
body { font-family: 'Hiragino Sans',sans-serif; background:#f7f3e8; color:#20211d; padding:16px; }
h1 { font-size:1.2rem; margin-bottom:12px; }
textarea,input { width:100%; border:2px solid #20211d; padding:8px; margin-bottom:8px; font:inherit; }
button { border:2px solid #20211d; background:#f0b429; padding:10px 16px; font-weight:900; cursor:pointer; }
pre { border:2px solid #20211d; background:#fffaf0; padding:12px; margin-top:12px; white-space:pre-wrap; word-break:break-all; font-size:0.85rem; overflow-x:auto; }
.section { border:2px solid #20211d; background:#fffaf0; padding:16px; margin-top:16px; box-shadow:5px 5px 0 rgba(32,33,29,0.86); }
.section h3 { margin-bottom:8px; }
.reply { border:2px solid #20211d; background:#eef5ef; padding:12px; margin:4px 0; }
</style>
</head><body>
<h1>🔍 AI Debug — 生レスポンス確認</h1>
<input id="title" placeholder="スレタイ" value="朝礼が毎朝ある">
<textarea id="body" rows="3" placeholder="投稿内容">毎朝9時から15分の朝礼。全員が昨日やったこと今日やることを読み上げる。Slackに書いてあるのと同じ内容。</textarea>
<button onclick="test()">AIレス生成テスト</button>
<div id="out"></div>
<script>
async function test() {
  const title = document.getElementById('title').value;
  const body = document.getElementById('body').value;
  document.getElementById('out').innerHTML = '<p>⏳ AIに送信中...</p>';
  try {
    const res = await fetch('/debug/ai-test', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({title, body})
    });
    const data = await res.json();
    let html = '';
    html += '<div class="section"><h3>📊 メタ情報</h3><pre>' + JSON.stringify({
      ok: data.ok,
      finish_reason: data.finish_reason,
      content_length: data.content_length,
      reasoning_length: data.reasoning_length,
      parsed_replies: data.parsed_replies,
    }, null, 2) + '</pre></div>';
    html += '<div class="section"><h3>📝 Content（レス抽出元）</h3><pre>' + (data.raw_content || '(empty)') + '</pre></div>';
    html += '<div class="section"><h3>🤔 Reasoning（思考過程）</h3><pre>' + (data.raw_reasoning || '(empty)') + '</pre></div>';
    if (data.replies && data.replies.length > 0) {
      html += '<div class="section"><h3>✅ パース済みレス（' + data.replies.length + '件）</h3>';
      data.replies.forEach((r, i) => { html += '<div class="reply">#' + (i+1) + ' ' + r + '</div>'; });
      html += '</div>';
    }
    if (data.error) html += '<div class="section"><h3>❌ エラー</h3><pre>' + data.error + '</pre></div>';
    document.getElementById('out').innerHTML = html;
  } catch(e) {
    document.getElementById('out').innerHTML = '<pre>Error: ' + e.message + '</pre>';
  }
}
</script>
</body></html>`);
});

app.post('/debug/ai-test', async (c) => {
  const { generateReplies } = await import('@bs-job-board/agent');
  const { title, body } = await c.req.json<{title:string;body:string}>();
  try {
    const result = await generateReplies({
      threadTitle: title,
      targetBody: body,
      recentPosts: [],
      replyCount: 4,
      sakuraApiToken: c.env.SAKURA_API_TOKEN,
    });
    return c.json({
      ok: true,
      replies: result.replies,
      parsed_replies: result.replies.length,
      raw_content: result.rawContent,
      raw_reasoning: result.thinking,
      content_length: result.rawContent.length,
      reasoning_length: result.thinking.length,
    });
  } catch(e) {
    return c.json({ ok: false, error: String(e) }, 500);
  }
});
