import type { DataStorage } from "../../backend/base.js";

export const storage_failure = new Error("throwing-data-storage: boom");

export type ThrowMode = "sync" | "reject";

/**
 * DataStorage whose every method fails. `sync` throws before returning a
 * promise (a non-async implementation); `reject` returns a rejected promise.
 */
export function create_throwing_data_storage(mode: ThrowMode): DataStorage {
	const fail = <T>(): Promise<T> => {
		if (mode === "sync") throw storage_failure;
		return Promise.reject(storage_failure);
	};
	return {
		get: () => fail(),
		put: () => fail(),
		delete: () => fail(),
		exists: () => fail(),
	};
}
