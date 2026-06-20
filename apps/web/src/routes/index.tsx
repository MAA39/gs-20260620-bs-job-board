import { createFileRoute, Link } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import type { Thread } from '@bs-job-board/contracts';

const fetchThreads = createServerFn({ method: 'GET' }).handler(async () => {
  // CF Workers環境: cloudflare:workers からenvを取得
  // ローカル開発: フォールバック
  let apiBase = 'http://localhost:8787';
  try {
    const mod = await import('cloudflare:workers' as string);
    apiBase = (mod.env as Record<string, string>).API_BASE_URL ?? apiBase;
  } catch {
    // ローカル開発時はcloudflare:workersが存在しない
  }

  const res = await fetch(`${apiBase}/api/v1/threads`);
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
              {thread.body.length > 100 ? thread.body.slice(0, 100) + '...' : thread.body}
            </p>
          </div>
        </Link>
      ))}

      {threads.length === 0 && (
        <div className="card" style={{ textAlign: 'center', color: '#999' }}>
          まだ投稿がありません。
        </div>
      )}
    </div>
  );
}
