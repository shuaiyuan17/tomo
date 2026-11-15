import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";

/**
 * Transfer policy for the packaged bundle. `/assets/*` names carry a content
 * hash (Vite), so a browser may keep them for a year without asking again;
 * index.html, icons and the manifest keep the default `no-store`, so a new
 * build is picked up on the next load. Text is compressed once per file
 * version and kept in memory (the bundle is a handful of files); fonts and
 * images are already compressed and go out as they are.
 */
export const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";
const COMPRESSIBLE = new Set(["html", "js", "css", "svg", "webmanifest"]);
/** Below this, compression saves less than the header it adds. */
const MIN_COMPRESS_BYTES = 1024;
export type Encoding = "br" | "gzip";

/** The best encoding the request accepts: brotli, then gzip, else none (`q=0` refuses one). */
export function pickEncoding(header: string | string[] | undefined): Encoding | undefined {
  const accepted = new Map<string, number>();
  for (const part of (Array.isArray(header) ? header.join(",") : header ?? "").split(",")) {
    const [name, ...params] = part.trim().toLowerCase().split(";");
    if (!name) continue;
    const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
    const value = q ? Number(q.slice(2)) : 1;
    accepted.set(name, Number.isFinite(value) ? value : 0);
  }
  const allows = (name: Encoding) => (accepted.get(name) ?? accepted.get("*") ?? 0) > 0;
  return allows("br") ? "br" : allows("gzip") ? "gzip" : undefined;
}

const compressors: Record<Encoding, (bytes: Buffer) => Promise<Buffer>> = {
  br: (bytes) => promisify(brotliCompress)(bytes, { params: {
    [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT, [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length } }),
  gzip: (bytes) => promisify(gzip)(bytes, { level: 9 }),
};

/** Compressed copies by path, valid while the file's size and mtime are unchanged. */
export class CompressedAssets {
  private entries = new Map<string, { version: string; encoded: Map<Encoding, Promise<Buffer>> }>();

  static compressible(ext: string, size: number): boolean {
    return COMPRESSIBLE.has(ext) && size >= MIN_COMPRESS_BYTES;
  }

  get(path: string, version: string, encoding: Encoding, bytes: Buffer): Promise<Buffer> {
    let entry = this.entries.get(path);
    if (!entry || entry.version !== version) { entry = { version, encoded: new Map() }; this.entries.set(path, entry); }
    let encoded = entry.encoded.get(encoding);
    if (!encoded) {
      const target = entry;
      encoded = compressors[encoding](bytes);
      target.encoded.set(encoding, encoded);
      // A failure is not cached: the next request compresses again.
      encoded.catch(() => { if (target.encoded.get(encoding) === encoded) target.encoded.delete(encoding); });
    }
    return encoded;
  }
}
