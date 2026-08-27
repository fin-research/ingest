ALTER TABLE telegram_delivery ADD COLUMN workflow_instance_id TEXT;

CREATE INDEX telegram_delivery_workflow_idx
  ON telegram_delivery(workflow_instance_id)
  WHERE sent_at IS NULL;
