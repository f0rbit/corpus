/**
 * In-memory fakes of the Cloudflare platform interfaces consumed by
 * `backend/cloudflare.ts`, so the real backend code runs through the shared
 * contract suite without a wrangler process.
 *
 * - `create_fake_d1` — a `D1Database` fake backed by `bun:sqlite`. It
 *   implements exactly the surface drizzle-orm's d1 driver calls:
 *   `prepare(sql)` → `bind(...params)` → `{ run(), all(), raw() }`, plus
 *   `batch(statements)` which is atomic (real SQLite transaction), matching
 *   D1's documented batch semantics.
 * - `create_fake_r2` — an `R2Bucket` fake over a Map, with R2's
 *   single-consumption body semantics on `get`.
 *
 * The table DDL is derived from the Drizzle schema via `getTableConfig` so
 * Drizzle stays the single source of truth — schema changes flow into the
 * fake automatically, and unsupported schema features throw loudly instead
 * of silently diverging.
 */

import { Database, type SQLQueryBindings } from "bun:sqlite";
import { is } from "drizzle-orm";
import { getTableConfig, SQLiteColumn, type SQLiteTable } from "drizzle-orm/sqlite-core";
import type { CloudflareBackendConfig } from "../../backend/cloudflare";

const quote = (name: string): string => `"${name}"`;

export function table_ddl(table: SQLiteTable): string[] {
	const config = getTableConfig(table);

	if (config.foreignKeys.length > 0 || config.checks.length > 0 || config.uniqueConstraints.length > 0) {
		throw new Error(`table_ddl: unsupported constraint on ${config.name} — extend tests/fakes/cloudflare.ts`);
	}

	const columns = config.columns.map((col) => {
		if (col.hasDefault) {
			throw new Error(`table_ddl: column defaults not supported (${config.name}.${col.name})`);
		}
		const parts = [quote(col.name), col.getSQLType()];
		if (col.primary) parts.push("PRIMARY KEY");
		if (col.notNull) parts.push("NOT NULL");
		return parts.join(" ");
	});

	const composite_pks = config.primaryKeys.map(
		(pk) => `PRIMARY KEY (${pk.columns.map((c) => quote(c.name)).join(", ")})`,
	);

	const indexes = config.indexes.map((idx) => {
		const { name, columns: index_columns, unique, where } = idx.config;
		if (where) {
			throw new Error(`table_ddl: partial indexes not supported (${name})`);
		}
		const cols = index_columns.map((c) => {
			if (!is(c, SQLiteColumn)) {
				throw new Error(`table_ddl: SQL expression index columns not supported (${name})`);
			}
			return quote(c.name);
		});
		return `CREATE ${unique ? "UNIQUE " : ""}INDEX ${quote(name)} ON ${quote(config.name)} (${cols.join(", ")})`;
	});

	return [`CREATE TABLE ${quote(config.name)} (${[...columns, ...composite_pks].join(", ")})`, ...indexes];
}

type FakeD1Result = {
	results: Record<string, unknown>[];
	success: true;
	meta: Record<string, unknown>;
};

type FakeD1BoundStatement = {
	sql: string;
	params: unknown[];
	run: () => Promise<FakeD1Result>;
	all: () => Promise<FakeD1Result>;
	raw: () => Promise<unknown[][]>;
};

type FakeD1Statement = {
	bind: (...params: unknown[]) => FakeD1BoundStatement;
};

export type FakeD1 = CloudflareBackendConfig["d1"] & {
	prepare: (sql: string) => FakeD1Statement;
	batch: (statements: FakeD1BoundStatement[]) => Promise<FakeD1Result[]>;
	sqlite: Database;
};

export function create_fake_d1(tables: SQLiteTable[]): FakeD1 {
	const sqlite = new Database(":memory:");
	for (const statement of tables.flatMap(table_ddl)) {
		sqlite.run(statement);
	}

	const exec = (sql: string, params: unknown[]): FakeD1Result => {
		const results = sqlite.prepare(sql).all(...(params as SQLQueryBindings[])) as Record<string, unknown>[];
		return { results, success: true, meta: {} };
	};

	const prepare = (sql: string): FakeD1Statement => ({
		bind: (...params: unknown[]): FakeD1BoundStatement => ({
			sql,
			params,
			run: async () => exec(sql, params),
			all: async () => exec(sql, params),
			raw: async () => sqlite.prepare(sql).values(...(params as SQLQueryBindings[])),
		}),
	});

	const batch = async (statements: FakeD1BoundStatement[]): Promise<FakeD1Result[]> => {
		const run_atomically = sqlite.transaction(() => statements.map((s) => exec(s.sql, s.params)));
		return run_atomically();
	};

	return { prepare, batch, sqlite };
}

export type FakeR2 = CloudflareBackendConfig["r2"] & {
	has: (key: string) => boolean;
	keys: () => string[];
};

const drain = async (stream: ReadableStream<Uint8Array>): Promise<Uint8Array> => {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
	}
	const out = new Uint8Array(chunks.reduce((acc, c) => acc + c.length, 0));
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.length;
	}
	return out;
};

export function create_fake_r2(): FakeR2 {
	const objects = new Map<string, Uint8Array>();

	return {
		async get(key) {
			const bytes = objects.get(key);
			if (bytes === undefined) return null;

			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(bytes.slice());
					controller.close();
				},
			});

			return {
				body,
				arrayBuffer: async () => {
					if (body.locked) throw new Error("Body has already been used. It can only be used once.");
					const drained = await drain(body);
					const buffer = new ArrayBuffer(drained.byteLength);
					new Uint8Array(buffer).set(drained);
					return buffer;
				},
			};
		},

		async put(key, data) {
			const bytes = data instanceof Uint8Array ? data.slice() : await drain(data);
			objects.set(key, bytes);
		},

		async delete(key) {
			objects.delete(key);
		},

		async head(key) {
			return objects.has(key) ? { key } : null;
		},

		has: (key) => objects.has(key),
		keys: () => [...objects.keys()],
	};
}
