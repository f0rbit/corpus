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
