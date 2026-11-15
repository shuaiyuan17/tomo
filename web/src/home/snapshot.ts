/** Pure helpers for the picture of the room the page sends when Tomo asks to look (`home-look`). */

/** Decoded size of a base64 string. */
export function base64Bytes(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor(base64.length * 3 / 4) - padding;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The snapshot body (homeSnapshotSchema): the look's id is echoed only when it is one the schema accepts. */
export function snapshotBody(requestId: string, revision: string, png: string): { requestId?: string; revision: string; png: string } {
  return { ...(UUID.test(requestId) ? { requestId } : {}), revision, png };
}
