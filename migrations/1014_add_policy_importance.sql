ALTER TABLE policy_event
ADD COLUMN importance TEXT NOT NULL DEFAULT 'general'
CHECK (importance IN ('important', 'related', 'general'));
