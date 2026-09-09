// Blob storage for the tracer bullet.

import type { Bucket, StoragePort } from "../../contracts/storage.ts";

const blobs = new Map<string, { bytes: Uint8Array; contentType: string }>();

function keyOf(bucket: Bucket, key: string) {
  return `${bucket}/${key}`;
}

export function makeMemoryStorage(): StoragePort {
  return {
    async put(bucket, key, bytes, contentType) {
      blobs.set(keyOf(bucket, key), { bytes, contentType });
    },
    async get(bucket, key) {
      return blobs.get(keyOf(bucket, key))?.bytes ?? null;
    },
    async signedUrl(bucket, key, _ttlSeconds) {
      return `/api/v2/dev/blob/${bucket}/${key}`;
    },
  };
}

export function readBlob(bucket: string, key: string) {
  return blobs.get(`${bucket}/${key}`) ?? null;
}
