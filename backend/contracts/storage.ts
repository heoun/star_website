// Blob storage port over the two buckets that already exist.
// Implementations: adapters/storage-memory (Ring 1), adapters/storage-r2 (Ring 5).

export type Bucket = "listing-media" | "applicant-docs"; // public / private

export interface StoragePort {
  put(bucket: Bucket, key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(bucket: Bucket, key: string): Promise<Uint8Array | null>;
  // Time-limited read link for the private bucket.
  signedUrl(bucket: Bucket, key: string, ttlSeconds: number): Promise<string>;
}
