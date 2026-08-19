-- Prompt versions are deployment identifiers, not a two-value enum.
PRAGMA defer_foreign_keys = ON;

CREATE TABLE article_new (
  id TEXT PRIMARY KEY,
  news_id TEXT,
  title TEXT NOT NULL,
  published_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  link TEXT,
  author TEXT,
  summary TEXT,
  importance INTEGER CHECK (importance BETWEEN 0 AND 100),
  prompt_version TEXT
) WITHOUT ROWID;

INSERT INTO article_new (
  id, news_id, title, published_at, created_at, updated_at,
  link, author, summary, importance, prompt_version
)
SELECT
  id, news_id, title, published_at, created_at, updated_at,
  link, author, summary, importance, prompt_version
FROM article;

CREATE TABLE keyword_backup (
  article_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  topic TEXT NOT NULL,
  fact TEXT NOT NULL,
  interpretation TEXT NOT NULL,
  impact TEXT NOT NULL
);

INSERT INTO keyword_backup
SELECT article_id, ordinal, topic, fact, interpretation, impact
FROM keyword;

DROP TABLE keyword;
DROP TABLE article;
ALTER TABLE article_new RENAME TO article;

CREATE TABLE keyword (
  article_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  topic TEXT NOT NULL,
  fact TEXT NOT NULL,
  interpretation TEXT NOT NULL,
  impact TEXT NOT NULL,
  PRIMARY KEY (article_id, ordinal),
  FOREIGN KEY (article_id) REFERENCES article(id) ON DELETE CASCADE
) WITHOUT ROWID;

INSERT INTO keyword
SELECT article_id, ordinal, topic, fact, interpretation, impact
FROM keyword_backup;

DROP TABLE keyword_backup;
CREATE INDEX keyword_topic_idx ON keyword(topic);

PRAGMA defer_foreign_keys = OFF;
