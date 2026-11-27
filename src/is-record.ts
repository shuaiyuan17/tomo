/**
 * True for a non-null, non-array object: what a parsed JSON document calls an
 * object. Functions and primitives are not records; class instances, `Map`s
 * and `Date`s are (nothing here looks at the prototype).
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
