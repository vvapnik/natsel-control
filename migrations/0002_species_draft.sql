-- Species review: a new species is a draft until someone approves it; only approved species get traffic.
ALTER TABLE species ADD COLUMN approved_at TEXT;
ALTER TABLE species ADD COLUMN approved_by TEXT;
-- Species that existed before this migration are already in use: approve them.
UPDATE species SET approved_at = created_at, approved_by = 'migration';
