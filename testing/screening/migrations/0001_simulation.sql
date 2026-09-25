CREATE TABLE IF NOT EXISTS simulations (
  application_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('payment','screening')),
  record TEXT NOT NULL CHECK (json_valid(record)),
  PRIMARY KEY (application_id,kind)
);
