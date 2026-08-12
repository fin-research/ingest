-- Remove the quota-reservation table created by the pre-Git production migration.
DROP TABLE IF EXISTS ai_usage_reservation;
