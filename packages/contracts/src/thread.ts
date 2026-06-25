export type ThreadStatus = 'open' | 'fixed';
export type AuthorType = 'human' | 'ai';
export type PostRole = 'analyst' | 'structure' | 'transform' | 'comment' | 'thinking' | null;

export type Thread = {
  id: string;
  title: string;
  body: string;
  status: ThreadStatus;
  created_at: string;
};

export type Post = {
  id: string;
  thread_id: string;
  post_number: number;
  author_type: AuthorType;
  author_name: string;
  role: PostRole;
  body: string;
  source_post_number: number | null;
  user_id: string | null;
  created_at: string;
};

export type ThreadDetail = Thread & { posts: Post[] };

export type CreateThreadInput = { title: string; body: string };

/** Public API input — server-owned fields (author_type, role, etc.) are not accepted */
export type CreatePostInput = {
  body: string;
};
