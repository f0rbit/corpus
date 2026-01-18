import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");
const docsDir = join(rootDir, "docs/src/content/docs");

const pkg = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf-8"));

const readFile = (path) => readFileSync(join(rootDir, path), "utf-8");

const extractExports = (content) => {
	const exports = { functions: [], types: [], constants: [], classes: [] };
	
	const exportFunctionMatch = content.match(/export\s+(?:async\s+)?function\s+(\w+)/g) || [];
	exports.functions.push(...exportFunctionMatch.map(e => e.match(/function\s+(\w+)/)?.[1]).filter(Boolean));
	
	const exportConstMatch = content.match(/export\s+const\s+(\w+)/g) || [];
	exports.constants.push(...exportConstMatch.map(e => e.match(/const\s+(\w+)/)?.[1]).filter(Boolean));
	
	const exportTypeMatch = content.match(/export\s+type\s+(\w+)/g) || [];
	exports.types.push(...exportTypeMatch.map(e => e.match(/type\s+(\w+)/)?.[1]).filter(Boolean));
	
	const exportClassMatch = content.match(/export\s+class\s+(\w+)/g) || [];
	exports.classes.push(...exportClassMatch.map(e => e.match(/class\s+(\w+)/)?.[1]).filter(Boolean));
	
	const exportBraceMatch = content.match(/export\s*\{([^}]+)\}/g) || [];
	for (const match of exportBraceMatch) {
		const inner = match.match(/\{([^}]+)\}/)?.[1] || "";
		const items = inner.split(",").map(s => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
		for (const item of items) {
			if (item.startsWith("type ")) {
				exports.types.push(item.slice(5).trim());
			} else {
				exports.constants.push(item);
			}
		}
	}
	
	return exports;
};

const extractCodeExamples = (mdxContent) => {
	const examples = [];
	const codeBlockRegex = /```(?:typescript|ts|tsx)\n([\s\S]*?)```/g;
	let match;
	while ((match = codeBlockRegex.exec(mdxContent)) !== null) {
		const code = match[1].trim();
		if (code.length > 0 && code.length < 1500) {
			examples.push(code);
		}
	}
	return examples;
};

const extractFrontmatter = (mdxContent) => {
	const frontmatterMatch = mdxContent.match(/^---\n([\s\S]*?)\n---/);
	if (!frontmatterMatch) return {};
	
	const fm = {};
	const lines = frontmatterMatch[1].split("\n");
	for (const line of lines) {
		const colonIdx = line.indexOf(":");
		if (colonIdx > 0) {
			const key = line.slice(0, colonIdx).trim();
			const value = line.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, "");
			fm[key] = value;
		}
	}
	return fm;
};

const getMdxDocs = () => {
	const docs = [];
	const walkDir = (dir, basePath = "") => {
		if (!existsSync(dir)) return;
		const entries = readdirSync(dir, { withFileTypes: true });
		for (const entry of entries) {
			const fullPath = join(dir, entry.name);
			const relativePath = basePath ? `${basePath}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				walkDir(fullPath, relativePath);
			} else if (entry.name.endsWith(".mdx")) {
				const content = readFileSync(fullPath, "utf-8");
				const frontmatter = extractFrontmatter(content);
				const examples = extractCodeExamples(content);
				docs.push({
					path: relativePath,
					title: frontmatter.title || entry.name.replace(".mdx", ""),
					description: frontmatter.description || "",
					examples: examples.slice(0, 3),
				});
			}
		}
	};
	walkDir(docsDir);
	return docs;
};

const categorizeExports = () => {
	const categories = {
		core: ["create_corpus", "create_store", "define_store"],
		backends: ["create_memory_backend", "create_file_backend", "create_cloudflare_backend", "create_layered_backend"],
		codecs: ["json_codec", "text_codec", "binary_codec"],
		result: ["ok", "err", "match", "unwrap", "unwrap_or", "unwrap_err", "try_catch", "try_catch_async", "fetch_result", "pipe", "to_nullable", "to_fallback", "null_on", "fallback_on", "format_error", "at", "first", "last", "merge_deep"],
		observations: ["define_observation_type", "create_pointer", "pointer_to_key", "key_to_pointer", "resolve_path", "apply_span", "pointers_equal", "pointer_to_snapshot", "generate_observation_id", "create_observations_client", "create_observations_storage"],
		concurrency: ["Semaphore", "parallel_map"],
		utilities: ["compute_hash", "generate_version", "concat_bytes", "stream_to_bytes", "to_bytes", "create_filter_pipeline", "filter_snapshots", "parse_snapshot_meta"],
		schema: ["corpus_snapshots", "corpus_observations"],
		sst: ["createCorpusInfra"],
	};
	return categories;
};

const generateLlmsTxt = () => {
	const categories = categorizeExports();
	const mdxDocs = getMdxDocs();
	
	let output = `# ${pkg.name} v${pkg.version}

> ${pkg.description}

## Installation

\`\`\`bash
bun add ${pkg.name} zod
# or
npm install ${pkg.name} zod
\`\`\`

## Import Paths

\`\`\`typescript
// Main entry - core, memory backend, result utilities
import { create_corpus, define_store, json_codec, ok, err, pipe } from '@f0rbit/corpus'

// File backend (Node.js/Bun)
import { create_file_backend } from '@f0rbit/corpus/file'

// Cloudflare backend (Workers)
import { create_cloudflare_backend } from '@f0rbit/corpus/cloudflare'

// Types only (no runtime)
import type { Result, Snapshot, CorpusError, Store } from '@f0rbit/corpus/types'

// Drizzle schema
import { corpus_snapshots, corpus_observations } from '@f0rbit/corpus/schema'
\`\`\`

## Core Concepts

- **Snapshot**: Immutable versioned data with metadata (version, content_hash, parents, tags)
- **Store**: Typed container managing snapshots with automatic deduplication
- **Corpus**: Collection of stores bound to a backend
- **Observation**: Structured fact pointing to content location (store_id + version + path + span)
- **Lineage**: Parent refs link snapshots to sources for provenance tracking

## Builder Pattern

\`\`\`typescript
import { z } from 'zod'
import { create_corpus, create_memory_backend, define_store, json_codec } from '@f0rbit/corpus'

const UserSchema = z.object({ name: z.string(), email: z.string() })
const users = define_store('users', json_codec(UserSchema))

const corpus = create_corpus()
  .with_backend(create_memory_backend())
  .with_store(users)
  .build()

// Type-safe store access via corpus.stores.<id>
await corpus.stores.users.put({ name: 'Alice', email: 'alice@example.com' })
\`\`\`

## Result<T, E> Pattern

All operations return \`Result<T, CorpusError>\` - never throw exceptions.

\`\`\`typescript
import { ok, err, unwrap, unwrap_or, match, pipe, to_nullable } from '@f0rbit/corpus'

// Check .ok property
const result = await store.put(data)
if (!result.ok) return console.error('Failed:', result.error.kind)
console.log('Version:', result.value.version)

// Pattern matching
const message = match(result, meta => \`Stored \${meta.version}\`, error => \`Failed: \${error.kind}\`)

// Pipeline composition
const user = await pipe(store.get(version))
  .map(snapshot => snapshot.data)
  .flat_map(data => validateUser(data))
  .unwrap_or(defaultUser)

// Convert to nullable for not-found patterns
const snapshot = to_nullable(await store.get(version))
\`\`\`

## CorpusError Types

Discriminated union with \`kind\` field:
- \`not_found\` - Snapshot doesn't exist (store_id, version)
- \`storage_error\` - Backend failure (cause, operation)
- \`decode_error\` / \`encode_error\` - Codec failed (cause)
- \`hash_mismatch\` - Content corruption (expected, actual)
- \`validation_error\` - Schema validation failed (cause, message)
- \`observation_not_found\` - Observation doesn't exist (id)

\`\`\`typescript
if (!result.ok && result.error.kind === 'not_found') {
  return \`Version \${result.error.version} not found in \${result.error.store_id}\`
}
\`\`\`

## Store Operations

\`\`\`typescript
// Put - returns SnapshotMeta with generated version
const result = await store.put(data, {
  parents: [{ store_id: 'source', version: 'abc123' }],
  tags: ['draft'],
  invoked_at: new Date()
})

// Get specific version - returns Snapshot<T> = { meta, data }
const snapshot = await store.get('AZJx4vM')

// Get latest version
const latest = await store.get_latest()

// Get metadata only (no data fetch)
const meta = await store.get_meta('AZJx4vM')

// List with filtering - returns AsyncIterable<SnapshotMeta>
for await (const meta of store.list({ limit: 10, tags: ['published'] })) {
  console.log(meta.version)
}
\`\`\`

## Codecs

\`\`\`typescript
const jsonCodec = json_codec(z.object({ name: z.string() }))  // JSON with Zod validation
const textCodec = text_codec()    // Plain UTF-8 text
const binaryCodec = binary_codec() // Raw binary pass-through

// Custom codec
type Codec<T> = { content_type: ContentType; encode: (v: T) => Uint8Array; decode: (b: Uint8Array) => T }
\`\`\`

## Observations

\`\`\`typescript
import { define_observation_type } from '@f0rbit/corpus'

const entity_mention = define_observation_type('entity_mention', z.object({
  entity: z.string(),
  entity_type: z.enum(['person', 'organization', 'topic'])
}))

const corpus = create_corpus()
  .with_backend(backend)
  .with_store(documents)
  .with_observations([entity_mention])
  .build()

await corpus.observations.put(entity_mention, {
  source: { store_id: 'documents', version: 'AZJx4vM', path: '$.text', span: { start: 100, end: 150 } },
  content: { entity: 'Climate Policy', entity_type: 'topic' },
  confidence: 0.95
})

for await (const obs of corpus.observations.query({ type: 'entity_mention' })) {
  console.log(obs.content)
}
\`\`\`

## Backends

\`\`\`typescript
import { create_memory_backend, create_layered_backend } from '@f0rbit/corpus'
import { create_file_backend } from '@f0rbit/corpus/file'
import { create_cloudflare_backend } from '@f0rbit/corpus/cloudflare'

const memory = create_memory_backend()  // In-memory (testing)
const file = create_file_backend({ base_path: './data' })  // File system
const cf = create_cloudflare_backend({ db: env.DB, bucket: env.BUCKET })  // Cloudflare D1+R2
const layered = create_layered_backend({ primary: file, cache: memory })  // Cache layer
\`\`\`

## Concurrency Utilities

\`\`\`typescript
import { Semaphore, parallel_map } from '@f0rbit/corpus'

const sem = new Semaphore(5)
await sem.acquire()
try {
  await doWork()
} finally {
  sem.release()
}

// Or use parallel_map for controlled concurrency
const results = await parallel_map(items, item => process(item), 5)
\`\`\`

## SST Infrastructure Helper

\`\`\`typescript
import { createCorpusInfra } from '@f0rbit/corpus'

// In sst.config.ts
const corpus = createCorpusInfra('myapp')
const db = new sst.cloudflare.D1(corpus.database.name)      // 'myappDb'
const bucket = new sst.cloudflare.R2(corpus.bucket.name)    // 'myappBucket'
\`\`\`

## Exports by Category

### Core
${categories.core.map(e => `- \`${e}\``).join("\n")}

### Backends
${categories.backends.map(e => `- \`${e}\``).join("\n")}

### Codecs
${categories.codecs.map(e => `- \`${e}\``).join("\n")}

### Result Utilities
${categories.result.map(e => `- \`${e}\``).join("\n")}

### Observations
${categories.observations.map(e => `- \`${e}\``).join("\n")}

### Concurrency
${categories.concurrency.map(e => `- \`${e}\``).join("\n")}

### Utilities
${categories.utilities.map(e => `- \`${e}\``).join("\n")}

### Schema (Drizzle)
${categories.schema.map(e => `- \`${e}\``).join("\n")}

### SST
${categories.sst.map(e => `- \`${e}\``).join("\n")}

## Key Types

\`\`\`typescript
type SnapshotMeta = {
  store_id: string; version: string; content_hash: string; content_type: ContentType
  size_bytes: number; data_key: string; created_at: Date; invoked_at?: Date
  parents: ParentRef[]; tags?: string[]
}

type Snapshot<T> = { meta: SnapshotMeta; data: T }

type SnapshotPointer = {
  store_id: string; version: string
  path?: string           // JSONPath expression
  span?: { start: number; end: number }
}

type Observation<T> = {
  id: string; type: string; source: SnapshotPointer; content: T
  confidence?: number; observed_at?: Date; created_at: Date
  derived_from?: SnapshotPointer[]
}

type Result<T, E> = { ok: true; value: T } | { ok: false; error: E }

type Pipe<T, E> = {
  map: <U>(fn: (value: T) => U) => Pipe<U, E>
  map_async: <U>(fn: (value: T) => Promise<U>) => Pipe<U, E>
  flat_map: <U>(fn: (value: T) => Result<U, E> | Promise<Result<U, E>>) => Pipe<U, E>
  map_err: <F>(fn: (error: E) => F) => Pipe<T, F>
  tap: (fn: (value: T) => void | Promise<void>) => Pipe<T, E>
  tap_err: (fn: (error: E) => void | Promise<void>) => Pipe<T, E>
  unwrap_or: (default_value: T) => Promise<T>
  result: () => Promise<Result<T, E>>
}

type CorpusError =
  | { kind: 'not_found'; store_id: string; version: string }
  | { kind: 'already_exists'; store_id: string; version: string }
  | { kind: 'storage_error'; cause: Error; operation: string }
  | { kind: 'decode_error'; cause: Error }
  | { kind: 'encode_error'; cause: Error }
  | { kind: 'hash_mismatch'; expected: string; actual: string }
  | { kind: 'invalid_config'; message: string }
  | { kind: 'validation_error'; cause: Error; message: string }
  | { kind: 'observation_not_found'; id: string }
\`\`\`

## Common Patterns

\`\`\`typescript
// Deduplication is automatic - same content shares storage
const r1 = await store.put({ name: 'Alice' })
const r2 = await store.put({ name: 'Alice' })
// r1.value.data_key === r2.value.data_key (same hash)

// Lineage tracking
await derived.put(processedData, { parents: [{ store_id: 'raw', version: src }] })

// Async iteration
for await (const meta of store.list({ limit: 100 })) versions.push(meta.version)

// Error handling with pattern matching
const message = match(
  await store.get(version),
  snapshot => \`Found: \${snapshot.data.title}\`,
  error => error.kind === 'not_found' ? 'Not found' : \`Error: \${error.kind}\`
)

// Pipeline with early exit on error
const processed = await pipe(store.get(version))
  .map(s => s.data)
  .flat_map(data => transform(data))
  .tap(result => console.log('Transformed:', result))
  .result()
\`\`\`

## Links

- Documentation: https://f0rbit.github.io/corpus
- Repository: ${pkg.repository?.url || "https://github.com/f0rbit/corpus"}
`;

	return output;
};

const generateLlmsFullTxt = () => {
	const conciseTxt = generateLlmsTxt();
	
	const indexTs = readFile("index.ts");
	const typesTs = readFile("types.ts");
	const corpusTs = readFile("corpus.ts");
	const resultTs = readFile("result.ts");
	const utilsTs = readFile("utils.ts");
	const observationsTypesTs = readFile("observations/types.ts");
	const observationsUtilsTs = readFile("observations/utils.ts");
	const concurrencyTs = readFile("concurrency.ts");
	const schemaTs = readFile("schema.ts");
	const sstTs = readFile("sst.ts");

	let output = `# ${pkg.name} v${pkg.version} - Full Documentation

> ${pkg.description}

This document contains the complete source code and documentation for LLM consumption.

${conciseTxt}

---

## Full Source Code

### index.ts (Main Entry Point)

\`\`\`typescript
${indexTs}
\`\`\`

---

### types.ts (Type Definitions)

\`\`\`typescript
${typesTs}
\`\`\`

---

### corpus.ts (Core Implementation)

\`\`\`typescript
${corpusTs}
\`\`\`

---

### result.ts (Result Utilities)

\`\`\`typescript
${resultTs}
\`\`\`

---

### utils.ts (Utilities)

\`\`\`typescript
${utilsTs}
\`\`\`

---

### observations/types.ts (Observation Types)

\`\`\`typescript
${observationsTypesTs}
\`\`\`

---

### observations/utils.ts (Observation Utilities)

\`\`\`typescript
${observationsUtilsTs}
\`\`\`

---

### concurrency.ts (Concurrency Utilities)

\`\`\`typescript
${concurrencyTs}
\`\`\`

---

### schema.ts (Drizzle Schema)

\`\`\`typescript
${schemaTs}
\`\`\`

---

### sst.ts (SST Infrastructure)

\`\`\`typescript
${sstTs}
\`\`\`
`;

	return output;
};

const llmsTxt = generateLlmsTxt();
const llmsFullTxt = generateLlmsFullTxt();

writeFileSync(join(rootDir, "docs/public/llms.txt"), llmsTxt);
console.log("Generated docs/public/llms.txt");

writeFileSync(join(rootDir, "docs/public/llms-full.txt"), llmsFullTxt);
console.log("Generated docs/public/llms-full.txt");

console.log("\nLLM docs generated successfully!");
