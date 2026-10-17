// Caches of values read asynchronously (git output, parsed files), independent of the VS Code API.

/**
 * The value cached in `map` for `key`, read with `read` the first time. A read that fails (rejects, or gives a
 * value `failed` calls a failure) is dropped, so the next call tries again; above `max` entries the oldest goes.
 */
export function cached<T>(map: Map<string, Promise<T>>, key: string, read: () => Promise<T>, max: number,
  failed?: (value: T) => boolean): Promise<T> {
  const known = map.get(key);
  if (known) return known;
  const reading = read();
  map.set(key, reading);
  const drop = () => {
    if (map.get(key) === reading) map.delete(key);
  };
  reading.then(v => {
    if (failed?.(v)) drop();
  }, drop);
  if (map.size > max) map.delete(map.keys().next().value!);
  return reading;
}
