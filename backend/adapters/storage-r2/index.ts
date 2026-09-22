// Blob storage on the two R2 buckets the Worker already binds (wrangler.jsonc:
// MEDIA = listing-media, APPLICANT_DOCS = applicant-docs). `wrangler dev`
// simulates both locally, so this adapter works with zero cloud credentials.
//
// R2 bindings cannot mint presigned URLs; private files are served through an
// authenticated Worker route instead, which is the pattern the portal and the
// admin already use. signedUrl therefore returns that route.

import type { Bucket, StoragePort } from "../../contracts/storage.ts";

interface R2Object {
  arrayBuffer(): Promise<ArrayBuffer>;
}
interface R2Binding {
  put(key: string, value: Uint8Array | ArrayBuffer, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  get(key: string): Promise<R2Object | null>;
}

export interface R2Env {
  MEDIA: R2Binding;
  APPLICANT_DOCS: R2Binding;
}

function bindingFor(env: R2Env, bucket: Bucket): R2Binding {
  return bucket === "listing-media" ? env.MEDIA : env.APPLICANT_DOCS;
}

export function makeR2Storage(env: R2Env): StoragePort {
  return {
    async put(bucket, key, bytes, contentType) {
      await bindingFor(env, bucket).put(key, bytes.slice().buffer as ArrayBuffer, { httpMetadata: { contentType } });
    },
    async get(bucket, key) {
      const object = await bindingFor(env, bucket).get(key);
      if (!object) return null;
      return new Uint8Array(await object.arrayBuffer());
    },
    async signedUrl(bucket, key, _ttlSeconds) {
      return `/api/v2/files/${bucket}/${key}`;
    },
  };
}
