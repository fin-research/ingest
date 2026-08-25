CREATE TABLE telegram_delivery (
  article_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  published_at TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  telegram_message_id INTEGER NOT NULL
) WITHOUT ROWID;

CREATE INDEX telegram_delivery_sent_at_idx ON telegram_delivery(sent_at);
