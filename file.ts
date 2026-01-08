/**
 * File-system storage backend (Node.js/Bun only)
 *
 * This module uses Node.js filesystem APIs and Bun file APIs.
 * Import from '@f0rbit/corpus/file' to use this backend.
 */

export { create_file_backend, type FileBackendConfig } from './backend/file.js';
