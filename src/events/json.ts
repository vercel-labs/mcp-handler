/** Canonicalize plain JSON only; never silently discard or coerce values. */
export function canonical(
  value: unknown,
  ancestors = new Set<object>(),
): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value))
    return JSON.stringify(value);
  assertContainer(value, ancestors);

  ancestors.add(value);
  try {
    if (Array.isArray(value))
      return `[${Array.from(value, (item) => canonical(item, ancestors)).join(
        ",",
      )}]`;
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonical(
            (value as Record<string, unknown>)[key],
            ancestors,
          )}`,
      )
      .join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

/**
 * Deep-copy plain JSON, preserving key order. Like JSON.stringify, object
 * properties set to undefined are omitted; anything canonical() rejects throws.
 */
export function snapshotJson(
  value: unknown,
  ancestors = new Set<object>(),
): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return value;
  assertContainer(value, ancestors);

  ancestors.add(value);
  try {
    if (Array.isArray(value))
      return Array.from(value, (item) => snapshotJson(item, ancestors));
    const copy: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue;
      // defineProperty keeps a "__proto__" key as data, not a prototype.
      Object.defineProperty(copy, key, {
        value: snapshotJson(item, ancestors),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return copy;
  } finally {
    ancestors.delete(value);
  }
}

function assertContainer(
  value: unknown,
  ancestors: Set<object>,
): asserts value is object {
  if (
    typeof value !== "object" ||
    value === null ||
    ancestors.has(value) ||
    (!Array.isArray(value) &&
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  )
    throw new Error("Invalid JSON value");
}
