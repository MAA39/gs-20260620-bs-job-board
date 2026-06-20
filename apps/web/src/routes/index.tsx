import { createFileRoute, Link } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import type { Thread } from '@bs-job-board/contracts';

const API_BASE = process.env.API_BASE_URL ?? 'http://localhost:8787';

const fetchThreads = createServerFn({ method: 'GET' }).handler(async () => {
  const res = await fetch(`${API_BASE}/api/v1/threads`);
  return (await res.json()) as Thread[];
});

export const Route = createFileRoute('/')({
  loader: () => fetchThreads(),
  component: HomePage,
});

function HomePage() {
  const threads = Route.useLoaderData();

  return (
    <div>
      <h2 style={{ marginBottom: '16px' }}>投稿一覧</h2>

      {threads.map((thread) => (
        <Link key={thread.id} to="/threads/$id" params={{ id: thread.id }} style={{ textDecoration: 'none', color: 'inherit' }}>
          <div className="card" style={{ cursor: 'pointer' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3>{thread.title}</h3>
              <span className={`badge badge-${thread.status}`}>
                {thread.status === 'fixed' ? '✅ 整理完了' : '🔵 議論中'}
              </span>
            </div>
            <p style={{ color: '#666', marginTop: '4px', fontSize: '0.9rem' }}>
              {thread.body.slice(0, 100)}...
            </p>
          </div>
        </Link>
      ))}

      {threads.length === 0 && (
        <div className="card" style={{ textAlign: 'center', color: '#999' }}>
          まだ投稿がありません。最初のブルシット・ジョブを投稿してみましょう。
        </div>
      )}

      <div className="card" style={{ marginTop: '24px' }}>
        <h3 style={{ marginBottom: '12px' }}>新しいブルシット・ジョブを投稿</h3>
        <form method="POST" action="/api/create-thread">
          <input name="title" placeholder="タイトル（例: 週次報告書の二重入力）" required />
          <textarea name="body" placeholder="詳しく書いてください。何が無駄だと感じるか、どのくらいの時間がかかっているか等..." required />
          <button type="submit">投稿する</button>
        </form>
      </div>
    </div>
  );
}
