import { describe, test, expect, beforeEach } from "bun:test";
import { create_r2_data_storage, type R2S3Config } from "../../backend/remote-r2.js";
import type { DataStorage } from "../../backend/base.js";

// Mock S3 file handles for testing
type MockFileHandle = {
	exists: () => Promise<boolean>;
	arrayBuffer: () => Promise<ArrayBufferLike>;
	stream: () => ReadableStream<Uint8Array>;
	write: (data: Uint8Array) => Promise<unknown>;
	delete: () => Promise<void>;
	size: number;
};

type MockS3Client = {
	file: (key: string) => MockFileHandle;
};

describe("remote-r2 DataStorage adapter", () => {
	let mock_storage: Map<string, Uint8Array>;
	let mock_client: MockS3Client;
	let storage: DataStorage;

	beforeEach(() => {
		mock_storage = new Map();

		// Create a mock S3 client that stores data in memory
		mock_client = {
			file: (key: string) => ({
				exists: async () => mock_storage.has(key),
				arrayBuffer: async () => {
					const data = mock_storage.get(key);
					if (!data) throw new Error("NoSuchKey");
					return data.buffer;
				},
				stream: () => {
					const data = mock_storage.get(key);
					if (!data) throw new Error("NoSuchKey");
					return new ReadableStream({
						start(controller) {
							controller.enqueue(data);
							controller.close();
						},
					});
				},
				write: async (data: Uint8Array) => {
					mock_storage.set(key, new Uint8Array(data));
				},
				delete: async () => {
					mock_storage.delete(key);
				},
				size: mock_storage.get(key)?.byteLength ?? 0,
			}),
		};

		// Override Bun.S3Client for testing
		const bun = globalThis.Bun as unknown as Record<string, unknown>;
		const original_s3_client = bun.S3Client;
		bun.S3Client = function () {
			return mock_client;
		};

		const config: R2S3Config = {
			account_id: "test-account",
			bucket: "test-bucket",
			access_key_id: "test-key",
			secret_access_key: "test-secret",
			endpoint: "https://test.r2.cloudflarestorage.com",
		};

		storage = create_r2_data_storage(config);

		// Restore original S3Client after storage is created
		bun.S3Client = original_s3_client;
	});

	test("put and get round-trip data correctly", async () => {
		const key = "store/version1";
		const data = new Uint8Array([1, 2, 3, 4, 5]);

		await storage.put(key, data);

		const handle = await storage.get(key);
		expect(handle).not.toBeNull();

		if (handle) {
			const retrieved = await handle.bytes();
			expect(retrieved).toEqual(data);
		}
	});

	test("get returns null for missing keys", async () => {
		const handle = await storage.get("nonexistent");
		expect(handle).toBeNull();
	});

	test("exists returns true for existing keys", async () => {
		const key = "store/exists-test";
		const data = new Uint8Array([42]);

		await storage.put(key, data);

		const exists = await storage.exists(key);
		expect(exists).toBe(true);
	});

	test("exists returns false for missing keys", async () => {
		const exists = await storage.exists("nonexistent");
		expect(exists).toBe(false);
	});

	test("delete removes keys", async () => {
		const key = "store/to-delete";
		const data = new Uint8Array([1, 2, 3]);

		await storage.put(key, data);
		expect(await storage.exists(key)).toBe(true);

		await storage.delete(key);
		expect(await storage.exists(key)).toBe(false);
	});

	test("delete is idempotent (no error on missing key)", async () => {
		const key = "nonexistent";
		// Should not throw
		await storage.delete(key);
		expect(await storage.exists(key)).toBe(false);
	});

	test("stream provides native streaming", async () => {
		const key = "store/stream-test";
		const data = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

		await storage.put(key, data);

		const handle = await storage.get(key);
		expect(handle).not.toBeNull();

		if (handle && handle.stream) {
			const reader = handle.stream().getReader();
			const { done, value } = await reader.read();

			expect(done).toBe(false);
			expect(value).toEqual(data);
		}
	});

	test("handle includes size metadata", async () => {
		const key = "store/size-test";
		const data = new Uint8Array([1, 2, 3, 4, 5]);

		await storage.put(key, data);

		const handle = await storage.get(key);
		expect(handle).not.toBeNull();
		if (handle) {
			expect(handle.size).toBe(5);
		}
	});
});
