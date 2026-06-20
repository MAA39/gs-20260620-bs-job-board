import { createFileRoute, Link } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { useState, useEffect, useCallback, useMemo } from 'react';
import type { ThreadDetail, Post } from '@bs-job-board/contracts';

const API_URL = 'https://bs-job-board-api.masa-nekoshinshi39.workers.dev';

async function getApi() {
  try {
    const { env } = (await import('cloudflare:workers')) as { env: { API: { fetch: typeof fetch } } };
    return (url: string, init?: RequestInit) => env.API.fetch(`https://api${url}`, init);
  } catch {
    return (url: string, init?: RequestInit) => fetch(`http://localhost:8787${url}`, init);
  }
}

const fetchDetail = createServerFn({ method: 'GET' }).validator((i: { id: string }) => i)
  .handler(async ({ data }) => { const api = await getApi(); const r = await api(`/api/v1/threads/${data.id}`); if (!r.ok) throw new Error('not found'); return (await r.json()) as ThreadDetail; });

const addComment = createServerFn({ method: 'POST' }).validator((i: { threadId: string; body: string }) => i)
  .handler(async ({ data }) => { const api = await getApi(); await api(`/api/v1/threads/${data.threadId}/posts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ author_type: 'human', author_name: '名無しさん', role: null, body: data.body }) }); });

const fixThread = createServerFn({ method: 'POST' }).validator((i: { threadId: string; status: string }) => i)
  .handler(async ({ data }) => { const api = await getApi(); await api(`/api/v1/threads/${data.threadId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: data.status }) }); });

export const Route = createFileRoute('/threads/$id')({ loader: ({ params }) => fetchDetail({ data: { id: params.id } }), component: ThreadDetailPage });

function ThreadDetailPage() {
  const initial = Route.useLoaderData();
  const params = Route.useParams();
  const [thread, setThread] = useState(initial);
  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [streamThinking, setStreamThinking] = useState('');
  const [streamContent, setStreamContent] = useState('');
  const [streamSourceNum, setStreamSourceNum] = useState<number | null>(null);

  useEffect(() => { setThread(initial); }, [initial]);
  useEffect(() => {
    if (streaming) return;
    const p = setInterval(async () => { try { setThread(await fetchDetail({ data: { id: params.id } })); } catch {} }, 5000);
    return () => clearInterval(p);
  }, [params.id, streaming]);

  const startAiStream = useCallback(async (sourceNum: number) => {
    setStreaming(true); setStreamThinking(''); setStreamContent(''); setStreamSourceNum(sourceNum);
    try {
      const res = await fetch(`${API_URL}/api/v1/threads/${params.id}/ai-stream`, { method: 'POST' });
      if (!res.ok || !res.body) return;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n'); buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data: ') || line.includes('[DONE]')) continue;
          try {
            const chunk = JSON.parse(line.slice(6));
            const delta = chunk?.choices?.[0]?.delta || {};
            if (delta.reasoning_content) setStreamThinking(prev => prev + delta.reasoning_content);
            if (delta.content) setStreamContent(prev => prev + delta.content);
          } catch {}
        }
      }
    } finally {
      setStreaming(false); setStreamSourceNum(null);
      setTimeout(async () => { try { setThread(await fetchDetail({ data: { id: params.id } })); } catch {} }, 1000);
    }
  }, [params.id]);

  const handleComment = useCallback(async (e: React.FormEvent) => {
    e.preventDefault(); if (!comment.trim()) return; setSubmitting(true);
    try {
      await addComment({ data: { threadId: params.id, body: comment.trim() } });
      setComment('');
      const fresh = await fetchDetail({ data: { id: params.id } });
      setThread(fresh);
      const lastPost = fresh.posts[fresh.posts.length - 1];
      startAiStream(lastPost.post_number);
    } finally { setSubmitting(false); }
  }, [comment, params.id, startAiStream]);

  const handleFix = useCallback(async () => {
    await fixThread({ data: { threadId: params.id, status: thread.status === 'fixed' ? 'open' : 'fixed' } });
    setThread(await fetchDetail({ data: { id: params.id } }));
  }, [thread.status, params.id]);

  // グルーピング: 人間の投稿を基準にAIレスをぶら下げる
  const grouped = useMemo(() => {
    const posts = thread.posts;
    const humanPosts = posts.filter(p => p.author_type === 'human');
    const result: Array<{ human: Post; aiReplies: Post[]; thinking: Post[] }> = [];

    for (const hp of humanPosts) {
      const aiReplies = posts.filter(p => p.author_type === 'ai' && p.role !== 'thinking' && p.source_post_number === hp.post_number);
      const thinking = posts.filter(p => p.role === 'thinking' && p.source_post_number === hp.post_number);
      result.push({ human: hp, aiReplies, thinking });
    }

    // source_post_number が null の孤立AIレス（既存データ）
    const orphans = posts.filter(p => p.author_type === 'ai' && p.role !== 'thinking' && p.source_post_number == null);
    const orphanThink = posts.filter(p => p.role === 'thinking' && p.source_post_number == null);

    return { groups: result, orphans, orphanThink };
  }, [thread.posts]);

  return (
    <div>
      <Link to="/" style={{ color: '#555041', textDecoration: 'none', fontSize: '0.9rem' }}>← 一覧に戻る</Link>

      <div className="card" style={{ marginTop: '8px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div style={{ flex: 1 }}>
            <p className="eyebrow">Thread detail</p>
            <h2 style={{ fontFamily: 'Georgia, serif', fontSize: '1.4rem', marginTop: '4px' }}>{thread.title}</h2>
          </div>
          <button className="status-btn" onClick={handleFix} style={{ background: thread.status === 'fixed' ? '#eef5ef' : '#fffaf0' }}>
            {thread.status === 'fixed' ? '✅ 整理完了' : '🔓 議論中'}
          </button>
        </div>
      </div>

      <div className="section-header">
        <span>Posts</span>
        <span>{thread.posts.filter(p => p.role !== 'thinking').length}件{streaming ? ' · AI生成中...' : ' · 5秒で自動更新'}</span>
      </div>

      {/* 孤立AIレス（既存データ、source_post_number なし） */}
      {grouped.orphans.map((post) => (
        <div key={post.id} className="post post-ai">
          <div className="post-header"><strong>{post.post_number}</strong><span>{post.author_name}</span></div>
          <div className="post-body">{post.body}</div>
        </div>
      ))}

      {/* グルーピング表示 */}
      {grouped.groups.map(({ human, aiReplies, thinking }) => (
        <div key={human.id}>
          {/* 人間の投稿 */}
          <div className="post">
            <div className="post-header"><strong>{human.post_number}</strong><span>{human.author_name}</span></div>
            <div className="post-body">{human.body}</div>
          </div>

          {/* ぶら下がりAIレス */}
          <div style={{ marginLeft: '16px' }}>
            {aiReplies.map((post) => (
              <div key={post.id} className="post post-ai">
                <div className="post-header"><strong>{post.post_number}</strong><span>{post.author_name}</span></div>
                <div className="post-body">{post.body}</div>
              </div>
            ))}

            {/* SSEストリーミング（この人間コメントの下に表示） */}
            {streaming && streamSourceNum === human.post_number && (
              <>
                {streamThinking && (
                  <div className="post" style={{ background: '#fff8e1', borderStyle: 'dashed' }}>
                    <div className="post-header"><strong style={{ background: '#f0b429' }}>...</strong><span>🤔 思考中</span></div>
                    <div className="post-body" style={{ fontSize: '0.8rem', color: '#666' }}>{streamThinking}<span style={{ display: 'inline-block', width: '2px', height: '1em', background: '#20211d', animation: 'blink 1s infinite' }} /></div>
                  </div>
                )}
                {streamContent && (
                  <div className="post" style={{ background: '#eef5ef', borderStyle: 'dashed' }}>
                    <div className="post-header"><strong style={{ background: '#2f7d68' }}>...</strong><span>名無しさん@AI（生成中）</span></div>
                    <div className="post-body">{streamContent}<span style={{ display: 'inline-block', width: '2px', height: '1em', background: '#20211d', animation: 'blink 1s infinite' }} /></div>
                  </div>
                )}
              </>
            )}

            {thinking.map((post) => (
              <details key={post.id} className="thinking">
                <summary>🤔 AIの思考過程（タップで展開）</summary>
                <div style={{ marginTop: '8px', whiteSpace: 'pre-wrap' }}>{post.body}</div>
              </details>
            ))}
          </div>
        </div>
      ))}

      {grouped.orphanThink.map((post) => (
        <details key={post.id} className="thinking">
          <summary>🤔 AIの思考過程（タップで展開）</summary>
          <div style={{ marginTop: '8px', whiteSpace: 'pre-wrap' }}>{post.body}</div>
        </details>
      ))}

      <div className="card" style={{ marginTop: '16px' }}>
        <p className="eyebrow">Reply</p>
        <form onSubmit={handleComment} style={{ marginTop: '8px' }}>
          <input value={comment} onChange={e => setComment(e.target.value)} placeholder="名無しさんとしてレスを書く" required />
          <button type="submit" disabled={submitting || streaming}>{submitting ? '送信中...' : streaming ? 'AI生成中...' : 'レスする'}</button>
        </form>
      </div>

      <style dangerouslySetInnerHTML={{ __html: '@keyframes blink{0%,50%{opacity:1}51%,100%{opacity:0}}' }} />
    </div>
  );
}
