/**
 * How a message's meta line words its channel and time, and where the
 * conversation gets a day divider. Pure, so it is unit-tested.
 */

const CHANNEL_NAMES: Record<string, string> = { web: "Web", telegram: "Telegram", imessage: "iMessage" };

/** "imessage" → "iMessage", "telegram" → "Telegram"; an unknown channel is capitalised. */
export function channelLabel(channel: string | undefined): string {
  if (!channel) return "";
  return CHANNEL_NAMES[channel.toLowerCase()] ?? channel.charAt(0).toUpperCase() + channel.slice(1);
}

const TIME: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };
const DATE_TIME: Intl.DateTimeFormatOptions = { weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" };
const formatters = new Map<string, Intl.DateTimeFormat>();
/**
 * One Intl formatter per shape and locale. `toLocaleTimeString` /
 * `toLocaleString` with these options format exactly the same, but build a
 * new formatter on every call: a long history's meta lines paid for that.
 */
function formatter(shape: "time" | "dateTime", locale: string | undefined): Intl.DateTimeFormat {
  const key = `${shape}\n${locale ?? ""}`;
  let found = formatters.get(key);
  if (!found) { found = new Intl.DateTimeFormat(locale, shape === "time" ? TIME : DATE_TIME); formatters.set(key, found); }
  return found;
}

/** "6:32 AM" (no leading zero; 24-hour locales keep their own form). */
export function messageTime(timestamp: number, locale?: string): string {
  return formatter("time", locale).format(timestamp);
}

/** The full date and time, for the timestamp's tooltip. */
export function messageDateTime(timestamp: number, locale?: string): string {
  return formatter("dateTime", locale).format(timestamp);
}

function dayStart(timestamp: number): number {
  const d = new Date(timestamp); d.setHours(0, 0, 0, 0); return d.getTime();
}

/** True when two timestamps fall on different local calendar days. */
export function differentDay(a: number, b: number): boolean {
  return dayStart(a) !== dayStart(b);
}

/** "Today", "Yesterday", "Wednesday" (within the week), "Sat, Nov 8", or with the year once it is not this year's. */
export function dayLabel(timestamp: number, now = Date.now(), locale?: string): string {
  const days = Math.round((dayStart(now) - dayStart(timestamp)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  const date = new Date(timestamp);
  if (days > 1 && days < 7) return date.toLocaleDateString(locale, { weekday: "long" });
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(locale, { weekday: "short", month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) });
}

/**
 * The day a divider should announce before a message, or null: before the
 * first message shown, and wherever the day changes from the previous one.
 */
export function dividerBefore(previous: number | undefined, current: number, now = Date.now(), locale?: string): string | null {
  if (previous !== undefined && !differentDay(previous, current)) return null;
  return dayLabel(current, now, locale);
}

/** A scroller row's time: `late` rows (pending / live, always rendered after the history) never date earlier than the row before them. */
export interface DayStamp { at?: number; late?: boolean }

/**
 * Day labels for the chat's rows, placed so no row ever changes at its top
 * (rows may only grow at their ends; see chat-rows.ts):
 * `first` names the first row's day and sits above the rows (outside them);
 * `after[i]` is the divider at the END of row i, naming the day row i+1 starts.
 * A row without a time takes the next timed row's day (else `now`). A late
 * row (an old interrupted request is kept, and shown, after newer history)
 * is moved up to the previous row's day instead of announcing an earlier one.
 */
export function dayDividers(stamps: readonly DayStamp[], now = Date.now(), locale?: string): { first: string | null; after: (string | null)[] } {
  const days = new Array<number>(stamps.length);
  let upcoming = now;
  for (let i = stamps.length - 1; i >= 0; i--) { upcoming = stamps[i].at ?? upcoming; days[i] = upcoming; }
  for (let i = 1; i < days.length; i++) if (stamps[i].late && days[i] < days[i - 1]) days[i] = days[i - 1];
  return {
    first: days.length ? dayLabel(days[0], now, locale) : null,
    after: days.map((day, i) => i + 1 < days.length && differentDay(day, days[i + 1]) ? dayLabel(days[i + 1], now, locale) : null),
  };
}
