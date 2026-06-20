-- ユーザー別リアクション管理（1ユーザー1スレッド1回）
CREATE TABLE IF NOT EXISTS reactions (
  id         TEXT PRIMARY KEY,
  thread_id  TEXT NOT NULL REFERENCES threads(id),
  user_id    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(thread_id, user_id)
);
