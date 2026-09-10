import type { StoragePort } from "../../contracts/storage.ts";
import { storageBucket } from "../../../worker/storage.js";

export function makeSupabaseStorage(env: Record<string, unknown>): StoragePort {
  return {
    async put(bucket, key, bytes, contentType) {
      await storageBucket(env, bucket).put(key, bytes.slice().buffer, { httpMetadata: { contentType } });
    },
    async get(bucket, key) {
      const object = await storageBucket(env, bucket).get(key);
      return object ? new Uint8Array(await object.arrayBuffer()) : null;
    },
    async signedUrl(bucket, key) {
      // Stable application route; every download rechecks authorization.
      return `/api/v2/files/${bucket}/${key}`;
    }
  };
}
