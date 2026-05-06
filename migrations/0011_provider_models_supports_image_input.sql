-- Track which provider models accept image input. Used by the
-- `sandbox_load_image` tool to decide whether to return image bytes or
-- a text fallback. SQLite stores booleans as integers; 0 = false.

ALTER TABLE provider_models ADD COLUMN supports_image_input INTEGER NOT NULL DEFAULT 0;
