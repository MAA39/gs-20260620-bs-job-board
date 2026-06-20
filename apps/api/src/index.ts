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


// デバッグ: AIの生レスポンス — content と reasoning を明確に分離表示
app.get('/debug', (c) => {
  return c.html(`<!DOCTYPE html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AI Debug</title>
<style>
* { margin:0; padding:0; box-sizing:border-box; }
body { font-family:'Hiragino Sans',sans-serif; background:#f7f3e8; color:#20211d; padding:16px; max-width:720px; margin:0 auto; }
h1 { font-size:1.2rem; margin-bottom:12px; }
textarea,input { width:100%; border:2px solid #20211d; padding:8px; margin-bottom:8px; font:inherit; }
button { border:2px solid #20211d; background:#f0b429; padding:10px 16px; font-weight:900; cursor:pointer; }
.section { border:2px solid #20211d; padding:16px; margin-top:16px; box-shadow:4px 4px 0 rgba(32,33,29,0.86); }
.section h3 { margin-bottom:8px; font-size:1rem; }
.content-section { background:#eef5ef; }
.reasoning-section { background:#fff8e1; }
.meta-section { background:#fffaf0; }
.reply-item { border:2px solid #20211d; background:#fffaf0; padding:10px; margin:6px 0; }
pre { white-space:pre-wrap; word-break:break-all; font-size:0.85rem; overflow-x:auto; background:rgba(0,0,0,0.05); padding:10px; margin-top:8px; }
.label { font-size:0.75rem; font-weight:900; color:#a23b1f; text-transform:uppercase; }
</style>
</head><body>
<h1>🔍 AI Debug</h1>
<input id="title" placeholder="スレタイ" value="朝礼が毎朝ある">
<textarea id="body" rows="3">毎朝9時から15分の朝礼。全員が昨日やったこと今日やることを読み上げる。Slackに書いてあるのと同じ内容。</textarea>
<button onclick="test()">テスト生成</button>
<div id="out"></div>
<script>
async function test() {
  document.getElementById('out').innerHTML = '<p>⏳ 送信中...</p>';
  try {
    const res = await fetch('/debug/ai-test', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({title:document.getElementById('title').value, body:document.getElementById('body').value})
    });
    const d = await res.json();
    let h = '';

    h += '<div class="section meta-section"><h3>📊 メタ情報</h3>';
    h += '<p>Content: ' + d.content_length + '文字 / Reasoning: ' + d.reasoning_length + '文字 / パース済み: ' + d.parsed_replies + '件</p></div>';

    h += '<div class="section content-section"><p class="label">Content（AIの出力）</p>';
    h += '<pre>' + (d.raw_content || '(empty)') + '</pre></div>';

    if (d.replies && d.replies.length > 0) {
      h += '<div class="section content-section"><p class="label">パース済みレス（' + d.replies.length + '件）</p>';
      d.replies.forEach((r, i) => { h += '<div class="reply-item">#' + (i+1) + ' ' + r + '</div>'; });
      h += '</div>';
    }

    h += '<div class="section reasoning-section"><p class="label">Reasoning（思考過程）</p>';
    h += '<details><summary>タップで展開（' + d.reasoning_length + '文字）</summary>';
    h += '<pre>' + (d.raw_reasoning || '(empty)') + '</pre></details></div>';

    if (d.error) h += '<div class="section" style="background:#ffe1d8"><p class="label">エラー</p><pre>' + d.error + '</pre></div>';
    document.getElementById('out').innerHTML = h;
  } catch(e) { document.getElementById('out').innerHTML = '<pre>Error: ' + e.message + '</pre>'; }
}
</script>
</body></html>`);
});

app.post('/debug/ai-test', async (c) => {
  const { generateReplies } = await import('@bs-job-board/agent');
  const { title, body } = await c.req.json<{title:string;body:string}>();
  try {
    const result = await generateReplies({ threadTitle: title, targetBody: body, recentPosts: [], replyCount: 4, sakuraApiToken: c.env.SAKURA_API_TOKEN });
    return c.json({ ok: true, replies: result.replies, parsed_replies: result.replies.length, raw_content: result.rawContent, raw_reasoning: result.thinking, content_length: result.rawContent.length, reasoning_length: result.thinking.length });
  } catch(e) { return c.json({ ok: false, error: String(e) }, 500); }
});
