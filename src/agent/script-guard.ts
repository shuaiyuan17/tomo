/**
 * REPLY SCRIPT GUARD — notices when a reply drifts out of the owner's language.
 *
 * The failure: the owner writes in Chinese and the reply comes back in English.
 * The model does not notice it is doing this, and a rule in the prompt has not
 * held — the drift recurs across days and model versions while proactive sends
 * (composed differently) stay in Chinese. So the check lives at the outlet,
 * like the fabricated-marker guard in inbound-markers.ts.
 *
 * POLICY (v1): OBSERVE, DON'T REWRITE. The block ships unchanged; the outlet
 * logs the mismatch and queues one note for the session's next turn. Rewriting
 * would cost a second generation and the owner can read both languages; the
 * problem is the experience, not comprehension.
 *
 * WHAT COUNTS: only Han characters vs Latin letters, after removing what is
 * legitimately in another script — URLs, code (fenced and inline), quoted
 * spans (a drafted English comment for the owner to paste is a real reply),
 * and harness markers. Mixed inbound ("Under 新proposal，mode还是…") counts as
 * Chinese: any real share of Han means he wrote in Chinese. An all-English
 * inbound expects nothing, so answering English in English never trips it.
 */

export type Script = "han" | "latin" | "unknown";

const HAN = /\p{Script=Han}/gu;
const LATIN = /\p{Script=Latin}/gu;

/** Remove spans whose script says nothing about the language of the reply. */
export function stripNeutral(text: string, opts: { stripQuoted?: boolean } = {}): string {
  let s = text;
  s = s.replace(/```[\s\S]*?```/g, " ").replace(/~~~[\s\S]*?~~~/g, " ");
  s = s.replace(/`[^`\n]*`/g, " ");
  s = s.replace(/https?:\/\/\S+/g, " ");
  // Harness stamps and envelopes the model may echo or that lead an inbound prompt.
  s = s.replace(/<tomo-event[\s\S]*?(<\/tomo-event>|$)/g, " ");
  s = s.replace(/^\[[^\]\n]*·[^\]\n]*\]\s*/gm, " ");
  s = s.replace(/\[(Image|Sent an image|Sent a sticker)[^\]]*\]/g, " ");
  s = s.replace(/^(MEDIA|STICKER):\S+$/gm, " ");
  if (opts.stripQuoted) {
    s = s.replace(/"[^"\n]{12,}"/g, " ").replace(/“[^”]{12,}”/g, " ").replace(/^>.*$/gm, " ");
  }
  return s;
}

function counts(s: string): { han: number; latin: number } {
  return { han: s.match(HAN)?.length ?? 0, latin: s.match(LATIN)?.length ?? 0 };
}

/** What language the owner wrote in. Han if Han characters make up ≥ 8% of the letters: a mixed message ("Under 新proposal，mode还是per run ceiling吗" is ~12%) is still Chinese. */
export function inboundScript(text: string): Script {
  const { han, latin } = counts(stripNeutral(text));
  if (han === 0 && latin >= 20) return "latin";
  if (han > 0 && han / (han + latin) >= 0.08) return "han";
  return "unknown";
}

/**
 * Did this reply block come back in English to a Chinese message?
 * Needs a clear signal: no Han at all, and at least 40 Latin letters after
 * neutral spans and quoted drafts are removed.
 */
export function replyDrifted(inbound: string, block: string): boolean {
  if (inboundScript(inbound) !== "han") return false;
  const { han, latin } = counts(stripNeutral(block, { stripQuoted: true }));
  return han === 0 && latin >= 40;
}

export const SCRIPT_DRIFT_NOTE =
  "Your previous reply to the owner was in English, but he wrote in Chinese. Reply in Chinese. No need to mention or apologize for the switch.";
