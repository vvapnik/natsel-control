-- Gene pool: genes and their alleles. Allele 0 is the default (control).
CREATE TABLE genes (
  name        TEXT PRIMARY KEY CHECK (name GLOB '[a-z0-9]*.[a-z0-9]*'),
  description TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  removed_at  TEXT
);

CREATE TABLE alleles (
  gene  TEXT    NOT NULL REFERENCES genes(name),
  idx   INTEGER NOT NULL CHECK (idx >= 0),
  label TEXT    NOT NULL DEFAULT '',
  PRIMARY KEY (gene, idx)
);

-- Species: one allele per live gene.
CREATE TABLE species (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL DEFAULT '',
  parent_id  TEXT REFERENCES species(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  extinct_at TEXT
);

CREATE TABLE species_alleles (
  species_id TEXT    NOT NULL REFERENCES species(id),
  gene       TEXT    NOT NULL,
  allele     INTEGER NOT NULL,
  PRIMARY KEY (species_id, gene),
  FOREIGN KEY (gene, allele) REFERENCES alleles(gene, idx)
);

-- Population: species competing for the traffic of one niche.
CREATE TABLE populations (
  id         TEXT PRIMARY KEY CHECK (id GLOB '[a-z0-9-]*'),
  name       TEXT NOT NULL DEFAULT '',
  version    INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Current traffic distribution of a population, in basis points (sum = 10000).
CREATE TABLE distributions (
  population_id TEXT    NOT NULL REFERENCES populations(id),
  species_id    TEXT    NOT NULL REFERENCES species(id),
  share_bp      INTEGER NOT NULL CHECK (share_bp BETWEEN 0 AND 10000),
  PRIMARY KEY (population_id, species_id)
);

-- Append-only history of species and distributions.
CREATE TABLE history (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  at            TEXT NOT NULL DEFAULT (datetime('now')),
  actor         TEXT NOT NULL DEFAULT '',
  event         TEXT NOT NULL,
  species_id    TEXT,
  population_id TEXT,
  detail        TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX history_species ON history(species_id);
CREATE INDEX history_population ON history(population_id);
