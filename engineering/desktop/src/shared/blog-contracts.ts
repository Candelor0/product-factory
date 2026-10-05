export const BLOG_LIMITS = {
  titleLength: 160,
  bodyLength: 60_000,
  tagLength: 32,
  tagCount: 20,
  articleCount: 1_000,
  documentBytes: 8 * 1024 * 1024,
} as const;

export interface BlogArticleInput {
  title: string;
  body: string;
  tags: string[];
  status: 'draft' | 'published';
}

export interface BlogArticleUpdateInput extends BlogArticleInput {
  revision: number;
}

export interface BlogArticle extends BlogArticleInput {
  id: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface BlogDocument {
  schemaVersion: 1;
  articles: BlogArticle[];
}
