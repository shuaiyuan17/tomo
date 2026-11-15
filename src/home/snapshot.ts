import { HOME_SNAPSHOT_MAX_BYTES, WebError } from "../web/protocol.js";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Widest or tallest picture of the room accepted, in pixels. */
export const HOME_SNAPSHOT_MAX_SIDE = 8192;

/**
 * The PNG bytes of a snapshot's base64, checked: at most
 * HOME_SNAPSHOT_MAX_BYTES, the PNG signature, then an IHDR chunk with a sane
 * size. Throws WebError 413 / 400. Used by both the web process (before the
 * body crosses to the daemon) and the daemon (which does not trust it).
 */
export function decodeSnapshotPng(base64: string): Buffer {
  const png = Buffer.from(base64, "base64");
  if (png.length > HOME_SNAPSHOT_MAX_BYTES) throw new WebError(413, "snapshot_too_large");
  if (png.length < 33 || !png.subarray(0, 8).equals(PNG_SIGNATURE) || png.readUInt32BE(8) !== 13 || png.subarray(12, 16).toString("latin1") !== "IHDR") {
    throw new WebError(400, "invalid_snapshot");
  }
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (width < 1 || height < 1 || width > HOME_SNAPSHOT_MAX_SIDE || height > HOME_SNAPSHOT_MAX_SIDE) throw new WebError(400, "invalid_snapshot");
  return png;
}
