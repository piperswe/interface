-- Optional per-model pricing used when the provider doesn't return cost in
-- usage. Values are USD per 1,000,000 input/output tokens. NULL means
-- "unknown" — the cost calculation falls back to whatever the provider
-- reports (e.g. OpenRouter's `usage.cost`) and otherwise reports no cost.

ALTER TABLE provider_models ADD COLUMN input_cost_per_million_tokens REAL;
ALTER TABLE provider_models ADD COLUMN output_cost_per_million_tokens REAL;
