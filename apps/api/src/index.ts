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



// デバッグ: SSEストリーミングでAIの生成過程をリアルタイム表示
app.get('/debug', (c) => {
  return c.html(`<!DOCTYPE html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AI Debug — SSE Stream</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Hiragino Sans',sans-serif;background:#f7f3e8;color:#20211d;padding:16px;max-width:720px;margin:0 auto}
h1{font-size:1.2rem;margin-bottom:12px}
textarea,input{width:100%;border:2px solid #20211d;padding:8px;margin-bottom:8px;font:inherit}
button{border:2px solid #20211d;background:#f0b429;padding:10px 16px;font-weight:900;cursor:pointer}
.box{border:2px solid #20211d;padding:14px;margin-top:12px;box-shadow:4px 4px 0 rgba(32,33,29,0.86)}
.think{background:#fff8e1}
.content{background:#eef5ef}
.reply{border:2px solid #20211d;background:#fffaf0;padding:10px;margin:6px 0}
.label{font-size:.75rem;font-weight:900;color:#a23b1f;text-transform:uppercase;margin-bottom:6px}
#think-text,#content-text{white-space:pre-wrap;word-break:break-all;font-size:.85rem;min-height:40px}
.cursor{display:inline-block;width:2px;height:1em;background:#20211d;animation:blink 1s infinite}
@keyframes blink{0%,50%{opacity:1}51%,100%{opacity:0}}
</style>
</head><body>
<h1>🔍 AI Debug — SSE Stream</h1>
<input id="title" placeholder="スレタイ" value="朝礼が毎朝ある">
<textarea id="body" rows="3">毎朝9時から15分の朝礼。全員が昨日やったこと今日やることを読み上げる。Slackに書いてあるのと同じ内容。</textarea>
<button onclick="test()">テスト生成（SSE）</button>

<div class="box think" id="think-box">
  <div class="label">🤔 Reasoning（リアルタイム）</div>
  <div id="think-text"></div>
</div>

<div class="box content" id="content-box">
  <div class="label">📝 Content（リアルタイム）</div>
  <div id="content-text"></div>
</div>

<div id="replies-box" style="display:none" class="box" style="background:#fffaf0">
  <div class="label">✅ パース済みレス</div>
  <div id="replies-list"></div>
</div>

<script>
async function test() {
  const title = document.getElementById('title').value;
  const body = document.getElementById('body').value;
  const thinkEl = document.getElementById('think-text');
  const contentEl = document.getElementById('content-text');
  const repliesBox = document.getElementById('replies-box');
  const repliesList = document.getElementById('replies-list');

  thinkEl.textContent = '';
  contentEl.textContent = '';
  repliesBox.style.display = 'none';
  repliesList.innerHTML = '';
  thinkEl.innerHTML = '<span class="cursor"></span>';

  const res = await fetch('/debug/ai-stream', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({title, body})
  });

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const {value, done} = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, {stream: true});

    const lines = buffer.split('\\n');
    buffer = lines.pop();

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6);
      if (data === '[DONE]') continue;

      try {
        const chunk = JSON.parse(data);
        const delta = chunk?.choices?.[0]?.delta || {};

        if (delta.reasoning_content) {
          thinkEl.innerHTML = thinkEl.textContent + delta.reasoning_content + '<span class="cursor"></span>';
        }
        if (delta.content) {
          contentEl.innerHTML = contentEl.textContent + delta.content + '<span class="cursor"></span>';
        }
      } catch {}
    }
  }

  // カーソル除去
  thinkEl.innerHTML = thinkEl.textContent;
  contentEl.innerHTML = contentEl.textContent;

  // パース
  try {
    const json = JSON.parse(contentEl.textContent);
    if (json.replies) {
      repliesBox.style.display = 'block';
      json.replies.forEach((r, i) => {
        repliesList.innerHTML += '<div class="reply">#' + (i+1) + ' ' + r + '</div>';
      });
    }
  } catch {}
}
</script>
</body></html>`);
});

// SSEストリーミングプロキシ
app.post('/debug/ai-stream', async (c) => {
  const { title, body } = await c.req.json<{title:string;body:string}>();

  const SYSTEM_PROMPT = (await import('@bs-job-board/agent')).buildReplyPrompt
    ? `あなたは2chふう匿名掲示板の住民です。判断しない。材料を並べる。質問で終わらせない。辛辣にしない。JSON形式で{"replies":["レス1","レス2",...]}を返す。`
    : '';

  const { buildReplyPrompt } = await import('@bs-job-board/agent');
  const userPrompt = buildReplyPrompt({
    threadTitle: title, targetBody: body, recentPosts: [], replyCount: 4,
  });

  const sakuraRes = await fetch('https://api.ai.sakura.ad.jp/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${c.env.SAKURA_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-oss-120b',
      stream: true,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: 1500,
      temperature: 0.7,
    }),
  });

  if (!sakuraRes.ok || !sakuraRes.body) {
    return c.text('Sakura AI error: ' + sakuraRes.status, 502);
  }

  // SSEをそのままプロキシ
  return new Response(sakuraRes.body, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*',
    },
  });
});
