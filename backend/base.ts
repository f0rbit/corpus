/**
 * @module Backend Base
 * @description Base abstraction layer for backend implementations.
 */

import type {
  MetadataClient,
  DataClient,
  SnapshotMeta,
  Result,
  CorpusError,
  CorpusEvent,
  ListOpts,
  DataHandle,
} from "../types";
import { ok, err } from "../types";
import { to_bytes, filter_snapshots } from "../utils";
import { first, to_fallback } from "../result";

export type MetadataStorage = {
  get: (store_id: string, version: string) => Promise<SnapshotMeta | null>;
  put: (meta: SnapshotMeta) => Promise<void>;
  delete: (store_id: string, version: string) => Promise<void>;
  list: (store_id: string) => AsyncIterable<SnapshotMeta>;
  find_by_hash: (store_id: string, hash: string) => Promise<SnapshotMeta | null>;
};

export type DataStorage = {
  get: (data_key: string) => Promise<Uint8Array | null>;
  put: (data_key: string, data: Uint8Array) => Promise<void>;
  delete: (data_key: string) => Promise<void>;
  exists: (data_key: string) => Promise<boolean>;
};

type Emit = (event: CorpusEvent) => void;

export function create_metadata_client(
  storage: MetadataStorage,
  emit: Emit
): MetadataClient {
  return {
    async get(store_id, version): Promise<Result<SnapshotMeta, CorpusError>> {
      const meta = await storage.get(store_id, version);
      emit({ type: "meta_get", store_id, version, found: !!meta });
      if (!meta) {
        return err({ kind: "not_found", store_id, version });
      }
      return ok(meta);
    },

    async put(meta): Promise<Result<void, CorpusError>> {
      await storage.put(meta);
      emit({ type: "meta_put", store_id: meta.store_id, version: meta.version });
      return ok(undefined);
    },

    async delete(store_id, version): Promise<Result<void, CorpusError>> {
      await storage.delete(store_id, version);
      emit({ type: "meta_delete", store_id, version });
      return ok(undefined);
    },

    async *list(store_id, opts?: ListOpts): AsyncIterable<SnapshotMeta> {
      const all: SnapshotMeta[] = [];
      for await (const meta of storage.list(store_id)) {
        all.push(meta);
      }

      const filtered = filter_snapshots(all, opts);
      let count = 0;
      for (const meta of filtered) {
        yield meta;
        count++;
      }
      emit({ type: "meta_list", store_id, count });
    },

    async get_latest(store_id): Promise<Result<SnapshotMeta, CorpusError>> {
      let latest: SnapshotMeta | null = null;
      for await (const meta of storage.list(store_id)) {
        if (!latest || meta.created_at > latest.created_at) {
          latest = meta;
        }
      }

      if (!latest) {
        return err({ kind: "not_found", store_id, version: "latest" });
      }
      return ok(latest);
    },

    async *get_children(
      parent_store_id,
      parent_version
    ): AsyncIterable<SnapshotMeta> {
      for await (const meta of storage.list("")) {
        const is_child = meta.parents.some(
          (p) => p.store_id === parent_store_id && p.version === parent_version
        );
        if (is_child) yield meta;
      }
    },

    async find_by_hash(store_id, content_hash): Promise<SnapshotMeta | null> {
      return storage.find_by_hash(store_id, content_hash);
    },
  };
}

export function create_data_client(storage: DataStorage, emit: Emit): DataClient {
  return {
    async get(data_key): Promise<Result<DataHandle, CorpusError>> {
      const bytes = await storage.get(data_key);
      emit({
        type: "data_get",
        store_id: to_fallback(first(data_key.split("/")), data_key),
        version: data_key,
        found: !!bytes,
      });

      if (!bytes) {
        return err({ kind: "not_found", store_id: data_key, version: "" });
      }

      return ok({
        stream: () =>
          new ReadableStream({
            start(controller) {
              controller.enqueue(bytes);
              controller.close();
            },
          }),
        bytes: async () => bytes,
      });
    },

    async put(data_key, input): Promise<Result<void, CorpusError>> {
      const bytes = await to_bytes(input);
      await storage.put(data_key, bytes);
      return ok(undefined);
    },

    async delete(data_key): Promise<Result<void, CorpusError>> {
      await storage.delete(data_key);
      return ok(undefined);
    },

    async exists(data_key): Promise<boolean> {
      return storage.exists(data_key);
    },
  };
}
