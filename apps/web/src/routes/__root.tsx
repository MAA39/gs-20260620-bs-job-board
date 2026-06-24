import { HeadContent, Outlet, Scripts, createRootRoute, Link } from '@tanstack/react-router';

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'ブルシット・ジョブ解体掲示板' },
    ],
  }),
  shellComponent: RootShell,
  component: () => <Outlet />,
});

function RootShell({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <head>
        <HeadContent />
        <style dangerouslySetInnerHTML={{ __html: STYLES }} />
      </head>
      <body>
        <header>
          <div className="container">
            <p className="eyebrow">BS Job Board</p>
            <h1><Link to="/" search={{ sort: 'new' }} style={{ color: '#20211d', textDecoration: 'none' }}>ブルシット・ジョブ解体掲示板</Link></h1>
          </div>
        </header>
        <main className="container">{children}</main>
        <Scripts />
      </body>
    </html>
  );
}

const STYLES = `
:root { font-family: 'Hiragino Sans', 'Yu Gothic', Meiryo, sans-serif; font-size: 16px; line-height: 1.5; }
* { margin: 0; padding: 0; box-sizing: border-box; }
body { background: linear-gradient(90deg, rgba(32,33,29,0.06) 1px, transparent 1px), linear-gradient(rgba(32,33,29,0.05) 1px, transparent 1px), #f7f3e8; background-size: 28px 28px; color: #20211d; }
.container { max-width: 720px; margin: 0 auto; padding: 16px; }
header { border-bottom: 2px solid #20211d; background: #fffaf0; padding: 16px 0; }
header h1 { font-family: Georgia, 'Times New Roman', serif; font-size: 28px; font-weight: 800; line-height: 1; }
.eyebrow { color: #a23b1f; font-size: 12px; font-weight: 800; text-transform: uppercase; margin-bottom: 4px; }
.card { border: 2px solid #20211d; background: #fffaf0; padding: 16px; margin-bottom: 12px; box-shadow: 5px 5px 0 rgba(32,33,29,0.86); }
input, textarea { width: 100%; border: 2px solid #20211d; border-radius: 0; background: #fff; color: #20211d; font: inherit; padding: 10px 12px; margin-bottom: 8px; }
textarea { resize: vertical; min-height: 80px; }
button { border: 2px solid #20211d; border-radius: 0; background: #f0b429; color: #20211d; cursor: pointer; font: inherit; font-weight: 900; padding: 10px 16px; transition: transform 140ms ease, box-shadow 140ms ease; }
button:hover:not(:disabled) { transform: translate(-2px, -2px); box-shadow: 4px 4px 0 #20211d; }
button:disabled { cursor: not-allowed; opacity: 0.55; }
.post { border: 2px solid #20211d; background: #fffaf0; padding: 14px; margin-bottom: 10px; box-shadow: 4px 4px 0 rgba(32,33,29,0.86); }
.post-ai { background: #eef5ef; }
.post-header { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; font-size: 13px; color: #555041; }
.post-header strong { display: inline-grid; place-items: center; min-width: 28px; height: 28px; background: #20211d; color: #fffaf0; font-size: 13px; }
.post-body { margin-top: 10px; line-height: 1.8; white-space: pre-wrap; }
.section-header { display: flex; align-items: center; justify-content: space-between; border: 2px solid #20211d; background: #2f7d68; color: #fffaf0; padding: 10px 14px; font-weight: 900; font-size: 14px; margin-bottom: 10px; }
.react-btn { border: 2px solid #20211d; background: #fffaf0; padding: 6px 12px; font-weight: 900; font-size: 0.9rem; }
.thread-card { border: 2px solid #20211d; background: #fffaf0; padding: 14px; margin-bottom: 10px; box-shadow: 4px 4px 0 rgba(32,33,29,0.86); }
.thread-card:hover { transform: translate(-1px, -1px); box-shadow: 5px 5px 0 rgba(32,33,29,0.86); }
.thread-card a { text-decoration: none; color: inherit; }
.thread-title { font-weight: 900; font-size: 1.05rem; }
.thread-preview { color: #555041; font-size: 14px; margin-top: 4px; }
.badge { border: 1px solid #20211d; background: #fff; font-size: 11px; font-weight: 900; padding: 2px 7px; }
.status-btn { font-size: 0.8rem; padding: 4px 10px; white-space: nowrap; }
details.thinking { border: 1px solid #ddd; background: #fafafa; padding: 10px; margin-top: 10px; font-size: 0.8rem; color: #888; cursor: pointer; }
`;
