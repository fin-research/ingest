CREATE TABLE IF NOT EXISTS research_commentary (
  id TEXT PRIMARY KEY,
  policy_id TEXT UNIQUE,
  commentary_type TEXT NOT NULL CHECK (
    commentary_type IN ('current_affairs', 'policy_tracking', 'overseas_event')
  ),
  event_name TEXT NOT NULL,
  sources TEXT NOT NULL,
  event_published_at TEXT NOT NULL,
  commentary_date TEXT NOT NULL,
  event_summary TEXT NOT NULL,
  commentary TEXT NOT NULL,
  recommendation TEXT NOT NULL,
  model TEXT,
  prompt_version TEXT,
  generated_at TEXT,
  edited INTEGER NOT NULL DEFAULT 0 CHECK (edited IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (policy_id) REFERENCES policy_event(id) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS research_commentary_type_date_idx
  ON research_commentary (commentary_type, commentary_date DESC);
