/**
 * Thinking in the main chat. With config `showThinking` on, a thinking block
 * reaches the browser as an ordinary reply whose text starts with this
 * marker (`THINKING_MARKER` in src/agent/block-render.ts; a test keeps the
 * two equal — the server module is not imported into the bundle). The chat
 * shows such text as a folded "Thinking" row, never as the reply.
 */
export const THINKING_MARKER = "💭 ";

export interface ReplySegment { kind: "thinking" | "reply"; text: string }

/**
 * Split a reply body into thinking and reply segments, in order. Empty
 * segments are dropped; a body without the marker is returned whole, as is.
 *
 * - `block`: one content block as it was shipped (a live block). It is
 *   thinking exactly when it starts with the marker: the whole block.
 * - `joined`: a recorded turn, whose blocks the transcript joined with a
 *   single "\n" after trimming each (renderResponseBlocks), so where a
 *   thinking block ends is not recorded. A line starting with the marker
 *   opens thinking; it runs on across blank-line paragraph breaks and ends at
 *   the first single line break between two non-blank lines — which is
 *   always where the next block was joined on. A thinking block that itself
 *   has a single line break (a list, a wrapped line) therefore ends early and
 *   the rest of it shows as reply text: the safe direction, since the reply
 *   is never folded away.
 */
export function splitThinking(body: string, mode: "block" | "joined"): ReplySegment[] {
  if (!body.includes(THINKING_MARKER)) return [{ kind: "reply", text: body }];
  if (mode === "block") {
    if (!body.startsWith(THINKING_MARKER)) return [{ kind: "reply", text: body }];
    const text = body.slice(THINKING_MARKER.length).trim();
    return text ? [{ kind: "thinking", text }] : [];
  }
  const lines = body.split("\n");
  const segments: ReplySegment[] = [];
  const push = (kind: ReplySegment["kind"], text: string) => {
    if (!text.trim()) return;
    const last = segments.at(-1);
    if (last && last.kind === kind && kind === "reply") last.text += `\n${text}`;
    else segments.push({ kind, text: kind === "thinking" ? text.trim() : text });
  };
  let reply: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (!lines[i].startsWith(THINKING_MARKER)) { reply.push(lines[i++]); continue; }
    if (reply.length) { push("reply", reply.join("\n")); reply = []; }
    const thought = [lines[i++].slice(THINKING_MARKER.length)];
    while (i < lines.length && !lines[i].trim()) {
      // A blank-line break: the next paragraph is still this block's, unless it opens another thinking block.
      let next = i;
      while (next < lines.length && !lines[next].trim()) next++;
      if (next >= lines.length || lines[next].startsWith(THINKING_MARKER)) break;
      thought.push(...lines.slice(i, next + 1));
      i = next + 1;
    }
    push("thinking", thought.join("\n"));
  }
  if (reply.length) push("reply", reply.join("\n"));
  return segments;
}
