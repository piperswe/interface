-- Per-conversation overrides:
--   system_prompt: replaces the global system_prompt setting when non-null
--   (user_bio, the active style, and memories still apply on top).
ALTER TABLE conversations ADD COLUMN system_prompt TEXT NULL;
