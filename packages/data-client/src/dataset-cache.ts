/** Own cached documents; callers cannot change later reads through an earlier result. */
export function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export function memo<K, V>(capacity: number, read: (key: K) => Promise<V>, signal?: AbortSignal): (key: K) => Promise<V> {
  const values = new Map<K, V>();
  const pending = new Map<K, Promise<V>>();
  return async key => {
    signal?.throwIfAborted();
    if (values.has(key)) {
      const value = values.get(key)!;
      values.delete(key);
      values.set(key, value);
      // Cached reads observe cancellation queued before their promise settles.
      await Promise.resolve();
      signal?.throwIfAborted();
      return value;
    }
    const existing = pending.get(key);
    if (existing) return existing;
    const task = Promise.resolve().then(() => read(key)).then(value => {
      signal?.throwIfAborted();
      while (values.size >= capacity) values.delete(values.keys().next().value!);
      values.set(key, freeze(value));
      return value;
    }).finally(() => pending.delete(key));
    pending.set(key, task);
    return task;
  };
}

/** Four active file reads per dataset. A completed read hands its slot to the next waiter. */
export function boundedReader(read: (url: string) => Promise<unknown>, signal?: AbortSignal): (url: string) => Promise<unknown> {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async url => {
    signal?.throwIfAborted();
    if (active >= 4) await new Promise<void>(resolve => waiting.push(resolve));
    else active++;
    try {
      signal?.throwIfAborted();
      const value = await read(url);
      signal?.throwIfAborted();
      return value;
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}
