-- 投稿にBetter Authのuser_idを紐付け
ALTER TABLE posts ADD COLUMN user_id TEXT REFERENCES "user"(id);
