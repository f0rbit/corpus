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

/**
 * SST infrastructure helper for creating Corpus resources.
 * 
 * Generates resource names for D1 database and R2 bucket based on a prefix.
 * Returns objects compatible with SST resource definitions.
 * 
 * @param name - Base name prefix for resources
 * @param config - Optional overrides for resource names
 * @returns Resource definitions with database and bucket names
 * 
 * @example
 * ```ts
 * // In sst.config.ts
 * const corpus = createCorpusInfra('myapp')
 * 
 * const db = new sst.cloudflare.D1(corpus.database.name)
 * const bucket = new sst.cloudflare.R2(corpus.bucket.name)
 * 
 * // Resource names: 'myappDb', 'myappBucket'
 * ```
 */
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

/**
 * SQL migration script to create required D1 tables for the Cloudflare backend.
 * 
 * Must be executed on the D1 database before using `create_cloudflare_backend()`.
 * Creates the `corpus_snapshots` table and required indexes.
 * 
 * Safe to run multiple times (uses IF NOT EXISTS).
 * 
 * @example
 * ```ts
 * // Run migration via wrangler
 * // wrangler d1 execute <database-name> --command "$(cat migration.sql)"
 * 
 * // Or programmatically in a Worker
 * await env.CORPUS_DB.exec(CORPUS_MIGRATION_SQL)
 * ```
 */
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
