import { describe, it, expect } from "bun:test";
import { create_memory_backend } from "../../backend/memory.js";
import type { ObservationQueryOpts } from "../../observations/types.js";

const drain = async (iter: AsyncIterable<unknown>) => {
	const rows: unknown[] = [];
	for await (const row of iter) rows.push(row);
	return rows;
};

describe("ObservationsClient.query option typing", () => {
	const observations = create_memory_backend().observations!;

	it("rejects unknown keys passed through a variable (#57)", async () => {
		const opts = { type: "fact", content: { entity_id: "e1" } };
		// @ts-expect-error `content` is not an ObservationQueryOpts key
		const rows = await drain(observations.query(opts));
		expect(rows.length).toBe(0);
	});

	it("rejects unknown keys on query_meta and inline literals", async () => {
		const opts = { source_stor: "a" };
		// @ts-expect-error typo'd key
		await drain(observations.query_meta(opts));
		// @ts-expect-error inline excess key
		await drain(observations.query({ type: "fact", nope: 1 }));
	});

	it("accepts a variable typed ObservationQueryOpts", async () => {
		const opts: ObservationQueryOpts = { type: "fact", limit: 1 };
		expect((await drain(observations.query(opts))).length).toBe(0);
		expect((await drain(observations.query_meta(opts))).length).toBe(0);
	});

	it("accepts spreads of known keys and no argument", async () => {
		const base = { type: "fact", entity_key: "e1" };
		expect((await drain(observations.query({ ...base, limit: 5 }))).length).toBe(0);
		expect((await drain(observations.query())).length).toBe(0);
	});
});
