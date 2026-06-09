import type { DocumentAttachment, ImageAttachment } from "./types.js";
import { normalizeJpegBuffer, saveInboundImage, type ImageSaveMeta } from "./imageStore.js";
import {
  MAX_DOCUMENT_BYTES,
  readBodyWithCap,
  saveInboundDocument,
  type DocumentSaveMeta,
} from "./documentStore.js";
import { log } from "../logger.js";

export function isDeclaredDocumentTooLarge(
  declaredBytes: unknown,
  logContext: Record<string, unknown>,
): boolean {
  if (typeof declaredBytes !== "number" || declaredBytes <= MAX_DOCUMENT_BYTES) return false;
  log.warn(
    { ...logContext, max: MAX_DOCUMENT_BYTES },
    "Skipping oversized document attachment (pre-download)",
  );
  return true;
}

export async function readDocumentResponseWithCap(
  res: Response,
  logContext: Record<string, unknown>,
): Promise<Buffer | null> {
  const contentLengthHeader = res.headers.get("content-length");
  const contentLength = contentLengthHeader ? Number(contentLengthHeader) : NaN;
  if (Number.isFinite(contentLength) && contentLength > MAX_DOCUMENT_BYTES) {
    log.warn(
      { ...logContext, contentLength, max: MAX_DOCUMENT_BYTES },
      "Skipping oversized document attachment (Content-Length)",
    );
    res.body?.cancel().catch(() => {});
    return null;
  }

  const buffer = await readBodyWithCap(res, MAX_DOCUMENT_BYTES);
  if (!buffer) {
    log.warn(
      { ...logContext, max: MAX_DOCUMENT_BYTES },
      "Skipping oversized document attachment (streaming cap exceeded)",
    );
  }
  return buffer;
}

export async function buildImageAttachment(
  buffer: Buffer,
  mediaType: string,
  meta: ImageSaveMeta,
  baseDir: string | undefined,
): Promise<ImageAttachment> {
  const normalizedBuffer = await normalizeJpegBuffer(buffer, mediaType);
  const savedPath = baseDir
    ? (await saveInboundImage(normalizedBuffer, mediaType, meta, baseDir)) ?? undefined
    : undefined;

  return {
    data: normalizedBuffer.toString("base64"),
    mediaType,
    savedPath,
  };
}

export async function buildDocumentAttachment(
  buffer: Buffer,
  mediaType: string,
  meta: DocumentSaveMeta,
  baseDir: string | undefined,
): Promise<DocumentAttachment> {
  const savedPath = baseDir
    ? (await saveInboundDocument(buffer, mediaType, meta, baseDir)) ?? undefined
    : undefined;

  return {
    data: buffer.toString("base64"),
    mediaType,
    filename: meta.filename,
    savedPath,
  };
}
