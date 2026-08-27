DROP INDEX telegram_delivery_sent_at_idx;

ALTER TABLE telegram_delivery RENAME TO telegram_delivery_legacy;

CREATE TABLE telegram_delivery (
  article_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  published_at TEXT NOT NULL,
  discovered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sent_at TEXT,
  telegram_message_id INTEGER,
  CHECK (
    (sent_at IS NULL AND telegram_message_id IS NULL)
    OR (sent_at IS NOT NULL AND telegram_message_id IS NOT NULL)
  )
) WITHOUT ROWID;

INSERT INTO telegram_delivery (
  article_id,
  title,
  published_at,
  discovered_at,
  sent_at,
  telegram_message_id
)
SELECT
  article_id,
  title,
  published_at,
  sent_at,
  sent_at,
  telegram_message_id
FROM telegram_delivery_legacy;

DROP TABLE telegram_delivery_legacy;

CREATE INDEX telegram_delivery_sent_at_idx ON telegram_delivery(sent_at);
CREATE INDEX telegram_delivery_pending_idx
  ON telegram_delivery(discovered_at)
  WHERE sent_at IS NULL;
