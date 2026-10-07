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
  if (
    typeof value !== "object" ||
    ancestors.has(value) ||
    (!Array.isArray(value) &&
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  )
    throw new Error("Invalid JSON value");

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
