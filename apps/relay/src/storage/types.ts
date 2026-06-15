/**
 * Content-addressed blob storage for assets (TECHNICAL-SPEC §5 /v1/assets). Keys are asset hashes
 * (`sha256:<hex>`). In-memory impl backs dev/CI; a Supabase Storage impl is the production target
 * (same interface) — see docs/DECISIONS.md D1/D5.
 */
export interface StoredBlob {
  mime: string;
  bytes: Buffer;
}

export interface Storage {
  exists(hash: string): Promise<boolean>;
  put(hash: string, mime: string, bytes: Buffer): Promise<void>;
  get(hash: string): Promise<StoredBlob | null>;
  delete(hash: string): Promise<void>;
}

export class InMemoryStorage implements Storage {
  private readonly blobs = new Map<string, StoredBlob>();

  async exists(hash: string): Promise<boolean> {
    return this.blobs.has(hash);
  }

  async put(hash: string, mime: string, bytes: Buffer): Promise<void> {
    this.blobs.set(hash, { mime, bytes });
  }

  async get(hash: string): Promise<StoredBlob | null> {
    const blob = this.blobs.get(hash);
    return blob ? { mime: blob.mime, bytes: blob.bytes } : null;
  }

  async delete(hash: string): Promise<void> {
    this.blobs.delete(hash);
  }
}
