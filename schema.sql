-- Open Render Studio — canonical schema.
-- A project is a client engagement / room. Renders are the directed-edit runs
-- against a source image (its variants ARE the proposal board). Assets are the
-- studio's own reusable library (furniture pieces, house styles, materials)
-- that tools compose in — the differentiator over a generic staging SaaS.

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT 'Untitled Project',
  client_name TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS renders (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL DEFAULT '',
  tool_id TEXT NOT NULL,
  source_image_url TEXT NOT NULL,
  params TEXT NOT NULL DEFAULT '{}',   -- JSON of the tool's input values
  prompt TEXT NOT NULL DEFAULT '',     -- resolved prompt sent to the model
  result_image_url TEXT,
  result_video_url TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | done | error
  provider_job_id TEXT,                -- async video job id (OpenRouter /videos)
  error TEXT,
  disclaimer TEXT,                     -- e.g. dimensional-honesty note for geometry edits
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_renders_project ON renders(project_id);
CREATE INDEX IF NOT EXISTS idx_renders_created ON renders(created_at);

CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'furniture', -- furniture | style | material
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  image_url TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_assets_kind ON assets(kind);
