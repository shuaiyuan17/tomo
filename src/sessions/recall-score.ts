/**
 * Scoring for transcript recall (`recall_conversation`).
 *
 * The search this replaces was one lowercase substring test per message, so a
 * query only matched when its words appeared together, in order, exactly as
 * typed. Here a query is cut into tokens, every message is scored by which
 * tokens it holds, and rare tokens count more than common ones.
 *
 * No dependency and no dictionary. Text in scripts written without spaces
 * (Han, kana) is cut into overlapping two-character pieces; everything else is
 * cut into words.
 *
 * - Words are lowercased runs of letters and digits, kept at two characters or
 *   more, and matched as whole words: `id` does not match `idea`.
 * - A run of Han / kana characters gives its adjacent two-character pieces; a
 *   run of one character gives that character. They match as substrings.
 * - A piece that holds one of ten very common function characters is dropped,
 *   and so is such a character standing alone: "搬家的时间" is 搬家 + 时间,
 *   not also 家的 and 的时, which match half the transcript.
 * - A query that cuts to nothing ("的", "a") is matched as a whole substring.
 *
 * Token weights come from the scan itself: the scorer counts, for each token,
 * how many of the scanned messages hold it. A message's score for a query is
 * the weight of the tokens it holds over the weight of all the query's tokens,
 * plus `PHRASE_BONUS` when the whole query appears verbatim. Several queries
 * (phrasings) may be given; a message's score is its best over them.
 */

/** Function characters that make a two-character piece worthless. */
const FUNCTION_CHARS = new Set("的了是在和吗呢吧啊么");

/** A message must reach this score to be kept. */
export const RECALL_MIN_SCORE = 0.5;
/** Added when the whole query appears verbatim in the message. */
export const PHRASE_BONUS = 0.5;
/** A query with at least this many tokens needs `MIN_HITS_LONG_QUERY` hits. */
const LONG_QUERY_TOKENS = 3;
const MIN_HITS_LONG_QUERY = 2;
/** Tokens kept per query. A query is meant to be a few words; a pasted
 *  paragraph must not turn every message into dozens of substring tests. */
const MAX_TOKENS_PER_QUERY = 32;
/**
 * Rarity stops counting below one message in this many. Document counts of
 * one or two are noise, and without a ceiling a piece that happens to appear
 * once in the whole transcript outweighs the two real words next to it.
 */
const RARITY_CEILING = 1000;

const SPACELESS_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const WORD_CHAR = /[\p{L}\p{N}\p{M}]/u;
/** One run of spaceless-script characters, or one run of other word characters. */
const SEGMENT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+|(?:(?![\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])[\p{L}\p{N}\p{M}])+/gu;

export type RecallTokenKind =
  /** A word: matched whole, never inside a longer word. */
  | "word"
  /** A two-character piece (or a lone character) of a spaceless script: matched as a substring. */
  | "piece"
  /** The whole query, for a query that cut to no tokens: matched as a substring. */
  | "whole";

export interface RecallToken {
  text: string;
  kind: RecallTokenKind;
  /**
   * A piece cut from a run of three or more characters. Such a piece may
   * straddle two words ("搬家时间" gives 家时), so when it appears nowhere in
   * the scanned messages it is treated as an artefact of the cutting and left
   * out of the query, instead of counting as a rare word nothing matched.
   */
  maybeArtefact: boolean;
}

/** The code point starting at `index` (a lone surrogate is returned as is). */
function charAt(text: string, index: number): string {
  const code = text.codePointAt(index);
  return code === undefined ? "" : String.fromCodePoint(code);
}

/** The code point ending just before `index`. */
function charBefore(text: string, index: number): string {
  if (index <= 0) return "";
  const low = text.charCodeAt(index - 1);
  if (low >= 0xdc00 && low <= 0xdfff && index >= 2) {
    const high = text.charCodeAt(index - 2);
    if (high >= 0xd800 && high <= 0xdbff) return text.slice(index - 2, index);
  }
  return text[index - 1];
}

/** Is `char` part of a word, i.e. a letter, digit or mark outside the spaceless scripts? */
function isWordChar(char: string): boolean {
  if (char === "") return false;
  const code = char.charCodeAt(0);
  if (code < 128) {
    return (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || (code >= 65 && code <= 90);
  }
  return WORD_CHAR.test(char) && !SPACELESS_CHAR.test(char);
}

/**
 * `text` lowercased WITHOUT changing its length, so that an index into the
 * result is an index into `text`. `toLowerCase` can lengthen a string ("İ"
 * becomes two code units), and the excerpt is cut from the original at the
 * position a token was found in the lowercased copy. A character whose
 * lowercase form has another length is kept as it is.
 */
export function lowercaseInPlace(text: string): string {
  const lower = text.toLowerCase();
  if (lower.length === text.length) return lower;
  let out = "";
  for (const char of text) {
    const folded = char.toLowerCase();
    out += folded.length === char.length ? folded : char;
  }
  return out;
}

/**
 * Cut one query into tokens. Exported for tests; `RecallScorer` is the caller.
 * Returns an empty list for a query with nothing to cut ("的", "a", "!!").
 */
export function tokenizeRecallQuery(query: string): RecallToken[] {
  const tokens: RecallToken[] = [];
  const seen = new Set<string>();
  const add = (text: string, kind: RecallTokenKind, maybeArtefact: boolean): void => {
    const id = `${kind}:${text}`;
    if (seen.has(id)) return;
    seen.add(id);
    tokens.push({ text, kind, maybeArtefact });
  };
  for (const [segment] of lowercaseInPlace(query).matchAll(SEGMENT)) {
    const chars = Array.from(segment);
    if (!SPACELESS_CHAR.test(chars[0])) {
      if (chars.length >= 2) add(segment, "word", false);
      continue;
    }
    if (chars.length === 1) {
      if (!FUNCTION_CHARS.has(chars[0])) add(chars[0], "piece", false);
      continue;
    }
    for (let i = 0; i + 1 < chars.length; i++) {
      if (FUNCTION_CHARS.has(chars[i]) || FUNCTION_CHARS.has(chars[i + 1])) continue;
      add(chars[i] + chars[i + 1], "piece", chars.length >= 3);
    }
  }
  return tokens.slice(0, MAX_TOKENS_PER_QUERY);
}

/**
 * Where `needle` first appears in `haystack` (both lowercase), or -1.
 *
 * With `wholeWords`, an occurrence only counts when it is not glued to more
 * word characters: an edge of the needle that is a word character must not
 * have another word character next to it. Spaceless-script characters are not
 * word characters, so "offer" is found in "那个offer".
 */
function findIn(haystack: string, needle: string, wholeWords: boolean): number {
  let at = haystack.indexOf(needle);
  if (!wholeWords) return at;
  const guardStart = isWordChar(charAt(needle, 0));
  const guardEnd = isWordChar(charBefore(needle, needle.length));
  while (at !== -1) {
    const end = at + needle.length;
    const gluedBefore = guardStart && isWordChar(charBefore(haystack, at));
    const gluedAfter = guardEnd && isWordChar(charAt(haystack, end));
    if (!gluedBefore && !gluedAfter) return at;
    at = haystack.indexOf(needle, at + 1);
  }
  return -1;
}

interface ScoredQuery {
  /** The query lowercased and trimmed, for the verbatim bonus. */
  phrase: string;
  /** Whether a verbatim occurrence must stand clear of other word characters
   *  (false for a query matched as a plain substring). */
  wholeWords: boolean;
  /** Indexes into the scorer's token table. */
  tokens: number[];
}

interface Candidate<T> {
  item: T;
  /** Token-table indexes this message holds, with where each first appears. */
  tokens: number[];
  positions: number[];
  /** Bit i set: query i appears verbatim. */
  phraseMask: number;
}

export interface RecallScoredHit<T> {
  item: T;
  /** 0..1 for the share of the query matched, up to 1.5 with the verbatim bonus. */
  score: number;
  /** Index in the message text of the first matched token, for the excerpt. */
  matchIndex: number;
}

export interface RecallScoredResult<T> {
  /** The best `limit` hits, in the caller's newest-first order reversed (oldest first). */
  hits: RecallScoredHit<T>[];
  /** How many messages passed the filter, before `limit`. */
  matched: number;
}

/**
 * Scores the messages of one scan. `observe` every message in the search
 * window (matching or not: the token weights are counted over all of them),
 * then call `results` once.
 */
export class RecallScorer<T> {
  private readonly table: RecallToken[] = [];
  private readonly queries: ScoredQuery[] = [];
  /** Per token: how many observed messages hold it. */
  private readonly holders: number[] = [];
  private readonly candidates: Candidate<T>[] = [];
  private observed = 0;

  constructor(queries: readonly string[]) {
    const index = new Map<string, number>();
    const intern = (token: RecallToken): number => {
      const id = `${token.kind}:${token.text}`;
      const known = index.get(id);
      if (known !== undefined) {
        // The same piece cut from a short run in another phrasing is a word
        // the caller typed on its own: not an artefact anywhere.
        if (!token.maybeArtefact) this.table[known].maybeArtefact = false;
        return known;
      }
      index.set(id, this.table.length);
      this.table.push({ ...token });
      this.holders.push(0);
      return this.table.length - 1;
    };
    for (const raw of queries) {
      const phrase = lowercaseInPlace(raw.trim());
      if (phrase === "") continue;
      const tokens = tokenizeRecallQuery(phrase);
      if (tokens.length === 0) {
        this.queries.push({ phrase, wholeWords: false, tokens: [intern({ text: phrase, kind: "whole", maybeArtefact: false })] });
        continue;
      }
      this.queries.push({ phrase, wholeWords: true, tokens: tokens.map(intern) });
    }
  }

  /** True when no query was usable; nothing can match. */
  get isEmpty(): boolean {
    return this.queries.length === 0;
  }

  /** Count one message of the search window, and keep it if it holds any token. */
  observe(item: T, content: string): void {
    this.observed++;
    const lower = lowercaseInPlace(content);
    let tokens: number[] | null = null;
    let positions: number[] | null = null;
    for (let i = 0; i < this.table.length; i++) {
      const token = this.table[i];
      const at = findIn(lower, token.text, token.kind === "word");
      if (at === -1) continue;
      this.holders[i]++;
      (tokens ??= []).push(i);
      (positions ??= []).push(at);
    }
    if (tokens === null || positions === null) return;
    let phraseMask = 0;
    for (let q = 0; q < this.queries.length; q++) {
      const query = this.queries[q];
      // Verbatim implies every token is there, so the cheap test goes first.
      if (!query.tokens.every((t) => tokens.includes(t))) continue;
      if (findIn(lower, query.phrase, query.wholeWords) !== -1) phraseMask |= 1 << q;
    }
    this.candidates.push({ item, tokens, positions, phraseMask });
  }

  /**
   * The best `limit` messages. `newestFirst` orders two items the way the
   * caller's history runs (negative when `a` is the newer); it breaks ties
   * between equal scores toward the newer message and gives the final order,
   * which is oldest first.
   */
  results(limit: number, newestFirst: (a: T, b: T) => number): RecallScoredResult<T> {
    const weights = this.holders.map((holders) => this.weight(holders));
    const scored: RecallScoredHit<T>[] = [];
    // Scratch: where the current candidate holds each token, -1 when it doesn't.
    const where = new Array<number>(this.table.length).fill(-1);

    const plans = this.queries.map((query) => {
      const tokens = query.tokens.filter((t) => !(this.table[t].maybeArtefact && this.holders[t] === 0));
      const total = tokens.reduce((sum, t) => sum + weights[t], 0);
      const needed = tokens.length >= LONG_QUERY_TOKENS ? MIN_HITS_LONG_QUERY : 1;
      return { tokens, total, needed };
    });

    for (const candidate of this.candidates) {
      for (let i = 0; i < candidate.tokens.length; i++) where[candidate.tokens[i]] = candidate.positions[i];
      let best = -1;
      let bestIndex = 0;
      for (let q = 0; q < plans.length; q++) {
        const plan = plans[q];
        let held = 0;
        let weight = 0;
        let first = Infinity;
        for (const t of plan.tokens) {
          if (where[t] === -1) continue;
          held++;
          weight += weights[t];
          if (where[t] < first) first = where[t];
        }
        if (held < plan.needed) continue;
        const score = weight / plan.total + ((candidate.phraseMask >> q) & 1 ? PHRASE_BONUS : 0);
        if (score > best) {
          best = score;
          bestIndex = first;
        }
      }
      for (const t of candidate.tokens) where[t] = -1;
      if (best >= RECALL_MIN_SCORE) scored.push({ item: candidate.item, score: best, matchIndex: bestIndex });
    }

    scored.sort((a, b) => (b.score - a.score) || newestFirst(a.item, b.item));
    const kept = scored.slice(0, limit);
    kept.sort((a, b) => newestFirst(b.item, a.item));
    return { hits: kept, matched: scored.length };
  }

  /**
   * A token's weight: the usual inverse document frequency over the observed
   * messages, flat below one message in `RARITY_CEILING`. A token no message
   * holds weighs as much as the rarest that one does.
   */
  private weight(holders: number): number {
    const share = Math.max(holders, 1) / Math.max(this.observed, 1);
    return Math.log(1 + 1 / Math.max(share, 1 / RARITY_CEILING));
  }
}
