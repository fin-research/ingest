CREATE TABLE policy_article_next (
  policy_id TEXT NOT NULL,
  article_id TEXT NOT NULL,
  relation_status TEXT NOT NULL DEFAULT 'linked'
    CHECK (relation_status IN ('linked', 'excluded')),
  association_method TEXT NOT NULL
    CHECK (association_method IN ('ai', 'manual')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (policy_id, article_id),
  FOREIGN KEY (policy_id) REFERENCES policy_event(id) ON DELETE CASCADE,
  FOREIGN KEY (article_id) REFERENCES article(id) ON DELETE CASCADE
) WITHOUT ROWID;

INSERT INTO policy_article_next (
  policy_id, article_id, relation_status, association_method, created_at, updated_at
)
SELECT policy_id, article_id, relation_status, association_method, created_at, updated_at
FROM policy_article;

DROP INDEX IF EXISTS policy_article_article_idx;
DROP TABLE policy_article;
ALTER TABLE policy_article_next RENAME TO policy_article;

CREATE INDEX policy_article_article_idx
  ON policy_article (article_id, relation_status, updated_at);
