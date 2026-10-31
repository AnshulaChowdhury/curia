// own.ts — own-property access for maps keyed by data (node property keys, permission names,
// request JSON keys). A key such as `constructor` must not read an inherited value, and
// `__proto__` must be stored as a key rather than replace the object's prototype.

/** The map's own value for `key`, or undefined — never an inherited one. */
export function ownValue<T>(map: Readonly<Record<string, T>> | undefined, key: string): T | undefined {
  return map !== undefined && Object.hasOwn(map, key) ? map[key] : undefined;
}

/** Sets `key` as an own enumerable property, including `__proto__`. */
export function setOwn<T>(map: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(map, key, { value, enumerable: true, writable: true, configurable: true });
}
