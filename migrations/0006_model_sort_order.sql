-- Add sort_order to provider_models for user-defined ordering.

ALTER TABLE provider_models ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_provider_models_sort ON provider_models(user_id, provider_id, sort_order);
