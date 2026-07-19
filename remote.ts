/**
 * Remote backend for laptop-side Cloudflare access (Bun only)
 *
 * D1 over its HTTP `/raw` endpoint + R2 over its S3-compatible API via
 * Bun's native S3Client — reachable from a laptop with only a Cloudflare API
 * token, no Worker bindings required. Import from '@f0rbit/corpus/remote' to
 * use this backend.
 */

export { create_remote_backend, type RemoteBackendConfig } from "./backend/remote.js";
export { create_d1_http_db, d1_endpoint_url, type D1HttpConfig } from "./backend/remote-d1.js";
export { create_r2_data_storage, type R2S3Config } from "./backend/remote-r2.js";
