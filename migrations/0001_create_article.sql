CREATE TABLE IF NOT EXISTS article (
  article_id TEXT PRIMARY KEY,
  sentiment_id TEXT,
  news_id TEXT,
  title TEXT NOT NULL,
  published_at TEXT NOT NULL,
  discovered_at TEXT NOT NULL,
  CHECK (sentiment_id IS NOT NULL OR news_id IS NOT NULL)
) WITHOUT ROWID;
