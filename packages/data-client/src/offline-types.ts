import type { ReplayManifest } from '@windgrams/contracts/regional';

/** Hashes cover the exact published file bytes, before gzip decoding. */
export interface SnapshotFile {
  path: string;
  bytes: number;
  sha256: string;
}
export interface SnapshotInventory {
  schemaVersion: 1;
  /** Content identity for this bundle and selected files. */
  id: string;
  caseId: string;
  model: string;
  referenceTime: string;
  /** Last selected map hour. Profiles retain their original complete horizon. */
  validUntil: string;
  bundleUrl: string;
  manifest: ReplayManifest;
  hours: ReplayManifest['hours'];
  cellIndices: number[];
  files: SnapshotFile[];
  totalBytes: number;
}
/** Reopen after replacing or removing this slot; its previous files may be released. */
export interface SavedSnapshot {
  slot: string;
  savedAt: string;
  inventory: SnapshotInventory;
}
/** A private namespace for snapshots. put replaces one key atomically, including after process death. */
export interface SnapshotObjectStore {
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, bytes: Uint8Array): Promise<void>;
  remove(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
  /** Required when multiple hosts/tabs can mutate this namespace. Hold across the entire operation. */
  withLock?<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T>;
}
export type SnapshotByteReader = (url: string, signal?: AbortSignal) => Promise<Uint8Array>;
export type SnapshotHasher = (bytes: Uint8Array) => Promise<string>;
export interface PrepareRegionalSnapshotOptions {
  baseUrl: string;
  /** Dataset-relative case directory, e.g. soaring/v1/armenia-icon-eu-live. */
  casePath: string;
  /** Defaults to all published hours. Every hour contains all published scalar fields. */
  forecastHours?: readonly number[];
  /** Defaults to the primary site's shard when available. Profiles retain their full forecast horizon. */
  cellIndices?: readonly number[];
  read?: SnapshotByteReader;
  sha256?: SnapshotHasher;
  signal?: AbortSignal;
}
export interface SnapshotProgress {
  completedFiles: number;
  totalFiles: number;
  completedBytes: number;
  totalBytes: number;
}
export interface SaveSnapshotOptions {
  signal?: AbortSignal;
  /** Simultaneous reads, 1–8; defaults to 3. */
  concurrency?: number;
  onProgress?: (progress: SnapshotProgress) => void;
}
export interface SnapshotRepository {
  /** Commit this slot only after every selected file has been verified and stored. */
  save(slot: string, inventory: SnapshotInventory, options?: SaveSnapshotOptions): Promise<SavedSnapshot>;
  /** Read committed metadata and check that its files are present. No network requests. */
  open(slot: string): Promise<SavedSnapshot | null>;
  list(): Promise<SavedSnapshot[]>;
  /** Read and verify a selected file; null means it was outside the saved scope. */
  read(snapshot: SavedSnapshot, path: string): Promise<Uint8Array | null>;
  /** Remove a saved slot and files not shared by another saved slot. */
  remove(slot: string): Promise<void>;
  /** Discard unreferenced files, including interrupted downloads. Run when space is needed. */
  prune(): Promise<void>;
}

