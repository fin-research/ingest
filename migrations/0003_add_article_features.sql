ALTER TABLE article ADD COLUMN author TEXT;
ALTER TABLE article ADD COLUMN summary TEXT;
ALTER TABLE article ADD COLUMN importance INTEGER CHECK (importance BETWEEN 0 AND 100);
ALTER TABLE article ADD COLUMN feature_model TEXT;
ALTER TABLE article ADD COLUMN feature_prompt_version TEXT;
ALTER TABLE article ADD COLUMN feature_extracted_at TEXT;

CREATE TABLE keyword (
  article_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  topic TEXT NOT NULL,
  fact TEXT NOT NULL,
  interpretation TEXT NOT NULL,
  impact TEXT NOT NULL,
  PRIMARY KEY (article_id, ordinal),
  FOREIGN KEY (article_id) REFERENCES article(article_id) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE INDEX keyword_topic_idx ON keyword(topic);
