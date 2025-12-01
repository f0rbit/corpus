export type CorpusInfraConfig = {
  name: string
  bucket_name?: string
  database_name?: string
}

export type CorpusInfra = {
  database: { name: string }
  bucket: { name: string }
  database_name: string
  bucket_name: string
}

export function createCorpusInfra(
  name: string,
  config?: Partial<CorpusInfraConfig>
): CorpusInfra {
  const database_name = config?.database_name ?? `${name}Db`
  const bucket_name = config?.bucket_name ?? `${name}Bucket`

  return {
    database: { name: database_name },
    bucket: { name: bucket_name },
    database_name,
    bucket_name,
  }
}

export const CORPUS_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS corpus_snapshots (
  store_id TEXT NOT NULL,
  version TEXT NOT NULL,
  parents TEXT NOT NULL,
  created_at TEXT NOT NULL,
  invoked_at TEXT,
  content_hash TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  data_key TEXT NOT NULL,
  tags TEXT,
  PRIMARY KEY (store_id, version)
);

CREATE INDEX IF NOT EXISTS idx_store_created ON corpus_snapshots(store_id, created_at);
CREATE INDEX IF NOT EXISTS idx_content_hash ON corpus_snapshots(store_id, content_hash);
CREATE INDEX IF NOT EXISTS idx_data_key ON corpus_snapshots(data_key);
`
