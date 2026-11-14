/** SDK content-block type guards and the user-message content builder. */

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isTextBlock(block: unknown): block is { type: "text"; text: string } {
  return isObject(block) && block.type === "text" && typeof block.text === "string";
}

export function isThinkingBlock(block: unknown): block is { type: "thinking"; thinking: string } {
  return isObject(block) && block.type === "thinking" && typeof block.thinking === "string";
}

export function isToolUseBlock(block: unknown): block is { type: "tool_use"; id?: string; name: string; input?: Record<string, unknown> } {
  return isObject(block) && block.type === "tool_use" && typeof block.name === "string";
}

type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

export function buildContentBlocks(
  text: string,
  images?: Array<{ data: string; mediaType: string }>,
  documents?: Array<{ data: string; mediaType: string; filename?: string }>,
): Array<Record<string, unknown>> {
  const content: Array<Record<string, unknown>> = [];
  if (images && images.length > 0) {
    for (const img of images) {
      content.push({
        type: "image",
        source: { type: "base64", media_type: img.mediaType as ImageMediaType, data: img.data },
      });
    }
  }
  if (documents && documents.length > 0) {
    for (const doc of documents) {
      const block: Record<string, unknown> = {
        type: "document",
        source: { type: "base64", media_type: doc.mediaType, data: doc.data },
      };
      if (doc.filename) block.title = doc.filename;
      content.push(block);
    }
  }
  content.push({ type: "text", text });
  return content;
}
