import { beforeAll, describe, expect, test } from "bun:test";
import { z } from "zod";
import type { Arbitrary } from "fast-check";
import * as testing from "../../testing/index.js";
import { gzip_codec } from "../../codecs/gzip.js";
import { encrypt_codec } from "../../codecs/encrypt.js";
import { binary_codec, compose, concat_bytes, json_codec, stream_to_bytes, text_codec } from "../../utils.js";
import type { BytesCodec, Codec } from "../../types.js";

const fc = testing.fc;

let key: CryptoKey;

beforeAll(async () => {
	key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
});

const xor_bytes = (bytes: Uint8Array): Uint8Array => bytes.map((b) => b ^ 0x5a);

// A second streaming layer: with gzip it makes decode_stream layer ORDER observable.
const xor_layer = (): BytesCodec => ({
	content_type: "application/octet-stream",
	encode: async (bytes) => xor_bytes(bytes),
	decode: async (bytes) => xor_bytes(bytes),
	encode_stream: (value) =>
		new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(xor_bytes(value));
				controller.close();
			},
		}),
	decode_stream: (input) =>
		input.pipeThrough(
			new TransformStream<Uint8Array, Uint8Array>({
				transform(chunk, controller) {
					controller.enqueue(xor_bytes(chunk));
				},
			}),
		),
});

const collect = async <T>(stream: ReadableStream<T>): Promise<T[]> => {
	const reader = stream.getReader();
	const out: T[] = [];
	for (;;) {
		const read = await reader.read();
		if (read.done) return out;
		out.push(read.value);
	}
};

const chunked = (bytes: Uint8Array, cuts: readonly number[]): ReadableStream<Uint8Array> => {
	const points = [...new Set(cuts.map((c) => c % (bytes.length + 1)))].toSorted((a, b) => a - b);
	const bounds = [0, ...points, bytes.length];
	const parts = bounds.slice(0, -1).map((start, i) => bytes.slice(start, bounds[i + 1]));
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const part of parts) controller.enqueue(part);
			controller.close();
		},
	});
};

type LayerSet = {
	label: string;
	make: () => BytesCodec[];
	enc: boolean;
	dec: boolean;
	deterministic: boolean;
};

const none_set: LayerSet = { label: "none", make: () => [], enc: true, dec: true, deterministic: true };

const random_iv_set: LayerSet = { ...none_set, deterministic: false };

const layer_sets: LayerSet[] = [
	none_set,
	{ label: "gzip", make: () => [gzip_codec()], enc: true, dec: true, deterministic: false },
	{ label: "encrypt", make: () => [encrypt_codec(key)], enc: true, dec: false, deterministic: false },
	{
		label: "gzip,encrypt",
		make: () => [gzip_codec(), encrypt_codec(key)],
		enc: true,
		dec: false,
		deterministic: false,
	},
	{
		label: "encrypt,gzip",
		make: () => [encrypt_codec(key), gzip_codec()],
		enc: true,
		dec: false,
		deterministic: false,
	},
	{ label: "gzip,xor", make: () => [gzip_codec(), xor_layer()], enc: true, dec: true, deterministic: false },
	{ label: "xor,gzip", make: () => [xor_layer(), gzip_codec()], enc: true, dec: true, deterministic: false },
];

type Head<T> = {
	name: string;
	codec: () => Codec<T>;
	arb: Arbitrary<T>;
	join?: (chunks: T[]) => T;
};

// A (head, layers, value, chunking) draw with the codec type erased behind closures,
// so one property can range over the whole head x layers matrix.
type Scenario = {
	label: string;
	streams_match_expectation: () => boolean;
	round_trips: () => Promise<void>;
	encode_stream_decodes: () => Promise<void>;
	decode_stream_matches: () => Promise<void>;
};

const make_scenario = <T>(head: Head<T>, set: LayerSet, value: T, cuts: readonly number[]): Scenario => {
	const build = (): Codec<T> => compose(head.codec(), ...set.make());
	return {
		label: `compose(${head.name}, [${set.label}])`,
		streams_match_expectation: () => {
			const codec = build();
			const base = head.codec();
			return (
				(codec.encode_stream !== undefined) === (base.encode_stream !== undefined && set.enc) &&
				(codec.decode_stream !== undefined) === (base.decode_stream !== undefined && set.dec)
			);
		},
		round_trips: async () => {
			const codec = build();
			const decoded: unknown = await codec.decode(await codec.encode(value));
			expect(decoded).toEqual(value);
		},
		encode_stream_decodes: async () => {
			const codec = build();
			const enc = codec.encode_stream;
			if (!enc) return;
			const streamed = await stream_to_bytes(enc(value));
			const decoded: unknown = await codec.decode(streamed);
			expect(decoded).toEqual(value);
			if (set.deterministic) expect(streamed).toEqual(await codec.encode(value));
		},
		decode_stream_matches: async () => {
			const codec = build();
			const dec = codec.decode_stream;
			const join = head.join;
			if (!dec || !join) return;
			const bytes = await codec.encode(value);
			const streamed: unknown = join(await collect(dec(chunked(bytes, cuts))));
			const buffered: unknown = await codec.decode(bytes);
			expect(streamed).toEqual(buffered);
		},
	};
};

const record_schema = z.object({
	id: z.string(),
	count: z.number().int().min(1).max(1000),
	flag: z.boolean(),
	tags: z.array(z.string()),
});

const bytes_arb = fc.uint8Array({ maxLength: 2000 });

const scenario_arms = <T>(head: Head<T>, sets: LayerSet[]): Arbitrary<Scenario>[] =>
	sets.map((set) =>
		fc
			.tuple(head.arb, fc.array(fc.nat(), { maxLength: 6 }))
			.map(([value, cuts]) => make_scenario(head, set, value, cuts)),
	);

const scenario_arb: Arbitrary<Scenario> = fc.oneof(
	...scenario_arms<string>(
		{ name: "text_codec", codec: text_codec, arb: fc.string({ unit: "grapheme" }), join: (chunks) => chunks.join("") },
		layer_sets,
	),
	...scenario_arms<Uint8Array>(
		{ name: "binary_codec", codec: binary_codec, arb: bytes_arb, join: concat_bytes },
		layer_sets,
	),
	...scenario_arms(
		{ name: "json_codec", codec: () => json_codec(record_schema), arb: testing.arb(record_schema) },
		layer_sets,
	),
	...scenario_arms<Uint8Array>({ name: "gzip_codec", codec: gzip_codec, arb: bytes_arb, join: concat_bytes }, [
		none_set,
	]),
	...scenario_arms<Uint8Array>(
		{ name: "encrypt_codec", codec: () => encrypt_codec(key), arb: bytes_arb, join: concat_bytes },
		[random_iv_set],
	),
);

const RUNS = 200;

const check = (name: string, run: (s: Scenario) => Promise<void>): void => {
	test(name, async () => {
		await fc.assert(
			fc.asyncProperty(scenario_arb, async (s) => {
				await run(s);
			}),
			{ numRuns: RUNS },
		);
	});
};

describe("codec laws over the head x layers matrix", () => {
	check("decode(encode(v)) round-trips for every head and layer stack", (s) => s.round_trips());
	check("encode_stream output decodes to v (and equals encode when deterministic)", (s) => s.encode_stream_decodes());
	check("decode_stream over arbitrary chunking equals decode", (s) => s.decode_stream_matches());

	test("stream methods exist exactly when head and every layer have them", () => {
		fc.assert(
			fc.property(scenario_arb, (s) => {
				expect(s.streams_match_expectation()).toBe(true);
			}),
			{ numRuns: RUNS },
		);
	});
});

describe("text_codec streaming over multi-byte characters", () => {
	const multibyte = fc
		.array(fc.constantFrom("a", "é", "—", "日", "😀"), { minLength: 1, maxLength: 40 })
		.map((pieces) => pieces.join(""));

	test("decode_stream split at random offsets, including inside characters, equals decode", async () => {
		const codec = text_codec();
		const dec = codec.decode_stream;
		if (!dec) throw new Error("text_codec must expose decode_stream");
		await fc.assert(
			fc.asyncProperty(multibyte, fc.array(fc.nat(), { minLength: 1, maxLength: 8 }), async (text, cuts) => {
				const bytes = await codec.encode(text);
				const out = (await collect(dec(chunked(bytes, cuts)))).join("");
				expect(out).toBe(await codec.decode(bytes));
				expect(out).toBe(text);
			}),
			{ numRuns: 100 },
		);
	});

	test("a character split byte-by-byte decodes whole", async () => {
		const codec = text_codec();
		const dec = codec.decode_stream;
		if (!dec) throw new Error("text_codec must expose decode_stream");
		const bytes = await codec.encode("日😀");
		const out = (await collect(dec(chunked(bytes, [1, 2, 3, 4, 5, 6, 7])))).join("");
		expect(out).toBe("日😀");
	});
});
