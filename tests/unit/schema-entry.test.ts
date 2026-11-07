import { describe, test, expect } from "bun:test";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import * as schema from "../../schema.js";

describe("schema entry point", () => {
	test("exposes both corpus tables", () => {
		expect(getTableConfig(schema.corpus_snapshots).name).toBe("corpus_snapshots");
		expect(getTableConfig(schema.corpus_observations).name).toBe("corpus_observations");
	});
});
