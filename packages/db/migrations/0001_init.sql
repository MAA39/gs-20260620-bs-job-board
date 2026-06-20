-- threads: ブルシット・ジョブの投稿
CREATE TABLE IF NOT EXISTS threads (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- posts: AI分析レス + 人間コメント
CREATE TABLE IF NOT EXISTS posts (
  id            TEXT PRIMARY KEY,
  thread_id     TEXT NOT NULL REFERENCES threads(id),
  post_number   INTEGER NOT NULL,
  author_type   TEXT NOT NULL,
  author_name   TEXT NOT NULL,
  role          TEXT,
  body          TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_posts_thread ON posts(thread_id, post_number);
