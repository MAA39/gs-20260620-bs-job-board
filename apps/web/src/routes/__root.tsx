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
            <h1><Link to="/" style={{ color: 'white', textDecoration: 'none' }}>ブルシット・ジョブ解体掲示板</Link></h1>
          </div>
        </header>
        <main className="container">
          {children}
        </main>
        <Scripts />
      </body>
    </html>
  );
}

const STYLES = `
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f5f5f5; color: #333; line-height: 1.6; }
.container { max-width: 800px; margin: 0 auto; padding: 16px; }
header { background: #1a1a2e; color: white; padding: 16px 0; margin-bottom: 24px; }
header h1 { font-size: 1.4rem; }
.card { background: white; border-radius: 8px; padding: 16px; margin-bottom: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
.badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 0.75rem; font-weight: bold; }
.badge-open { background: #e3f2fd; color: #1565c0; }
.badge-fixed { background: #e8f5e9; color: #2e7d32; }
input, textarea { width: 100%; padding: 8px 12px; border: 1px solid #ddd; border-radius: 4px; font-size: 1rem; margin-bottom: 8px; }
textarea { min-height: 100px; resize: vertical; }
button { padding: 8px 24px; background: #1a1a2e; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 1rem; }
button:hover { background: #16213e; }
.post { border-left: 3px solid #ddd; padding: 12px; margin-bottom: 8px; background: #fafafa; border-radius: 0 4px 4px 0; }
.post-header { font-size: 0.85rem; color: #666; margin-bottom: 4px; }
`;
