-- AIレスがどの人間コメントへの返信かを紐付け
ALTER TABLE posts ADD COLUMN source_post_number INTEGER;
