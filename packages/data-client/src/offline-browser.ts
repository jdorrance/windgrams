import type { SnapshotObjectStore } from './offline-types.ts';

/** IndexedDB commits each object; Web Locks coordinate mutations across tabs. */
export function createBrowserSnapshotStore(name = 'windgrams-snapshots'): SnapshotObjectStore & { close(): Promise<void> } {
  let connection: Promise<IDBDatabase> | undefined;
  function database(): Promise<IDBDatabase> {
    return connection ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('objects');
      request.onerror = () => {
        connection = undefined;
        reject(request.error);
      };
      request.onsuccess = () => {
        request.result.onversionchange = () => {
          request.result.close();
          connection = undefined;
        };
        resolve(request.result);
      };
    });
  }

  async function transaction<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await database();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction('objects', mode);
      const request = operation(tx.objectStore('objects'));
      tx.oncomplete = () => resolve(request.result);
      tx.onabort = () => reject(tx.error ?? request.error ?? new Error('Saved forecast storage transaction aborted'));
      tx.onerror = () => {}; // onabort reports quota failures and other transaction errors.
    });
  }

  return {
    async get(key) {
      const value: unknown = await transaction('readonly', store => store.get(key));
      if (value === undefined) return null;
      if (!(value instanceof ArrayBuffer)) throw new Error('Saved forecast storage contains invalid bytes');
      return new Uint8Array(value);
    },
    async put(key, bytes) {
      await transaction('readwrite', store => store.put(Uint8Array.from(bytes).buffer, key));
    },
    async remove(key) {
      await transaction('readwrite', store => store.delete(key));
    },
    async list(prefix) {
      const range = IDBKeyRange.bound(prefix, `${prefix}\uffff`);
      return (await transaction('readonly', store => store.getAllKeys(range))).map(String);
    },
    async withLock<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
      if (!globalThis.navigator?.locks) throw new Error('This browser cannot coordinate saved forecast storage');
      return navigator.locks.request(`windgrams-snapshots:${name}`, { mode: 'exclusive', signal }, operation);
    },
    async close() {
      if (connection) (await connection).close();
      connection = undefined;
    },
  };
}
