/** API共通のエラーレスポンス */
export type ApiError = {
  error: string;
};

/** スレッド作成のレスポンス */
export type CreateThreadResponse = {
  id: string;
  title: string;
};

/** レス作成のレスポンス */
export type CreatePostResponse = {
  id: string;
  post_number: number;
};
