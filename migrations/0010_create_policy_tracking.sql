CREATE TABLE IF NOT EXISTS policy_event (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  category TEXT NOT NULL CHECK (
    category IN (
      'monetary', 'fiscal', 'real_estate', 'capital_market',
      'industry', 'trade', 'social', 'other'
    )
  ),
  departments_json TEXT NOT NULL,
  policy_date TEXT NOT NULL,
  first_news_at TEXT NOT NULL,
  last_news_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS policy_event_timeline_idx
  ON policy_event (policy_date DESC, last_news_at DESC);

CREATE TABLE IF NOT EXISTS policy_news (
  sentiment_id TEXT PRIMARY KEY,
  policy_id TEXT,
  news_id TEXT,
  title TEXT NOT NULL,
  published_at TEXT NOT NULL,
  tags_json TEXT NOT NULL,
  content TEXT,
  link TEXT,
  aggregation_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (aggregation_status IN ('pending', 'grouped')),
  workflow_instance_id TEXT,
  claimed_at TEXT,
  discovered_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (policy_id) REFERENCES policy_event(id) ON DELETE CASCADE,
  CHECK (
    (aggregation_status = 'pending' AND policy_id IS NULL)
    OR (aggregation_status = 'grouped' AND policy_id IS NOT NULL)
  )
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS policy_news_pending_idx
  ON policy_news (aggregation_status, claimed_at, published_at)
  WHERE aggregation_status = 'pending';

CREATE INDEX IF NOT EXISTS policy_news_policy_idx
  ON policy_news (policy_id, published_at);

CREATE TABLE IF NOT EXISTS policy_article (
  policy_id TEXT NOT NULL,
  article_id TEXT NOT NULL,
  relation_status TEXT NOT NULL DEFAULT 'linked'
    CHECK (relation_status IN ('linked', 'excluded')),
  association_method TEXT NOT NULL
    CHECK (association_method IN ('ai', 'manual')),
  confidence TEXT CHECK (confidence IN ('high', 'medium')),
  rationale TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (policy_id, article_id),
  FOREIGN KEY (policy_id) REFERENCES policy_event(id) ON DELETE CASCADE,
  FOREIGN KEY (article_id) REFERENCES article(id) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS policy_article_article_idx
  ON policy_article (article_id, relation_status, updated_at);
