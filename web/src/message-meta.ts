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

/** "6:32 AM" (no leading zero; 24-hour locales keep their own form). */
export function messageTime(timestamp: number, locale?: string): string {
  return new Date(timestamp).toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
}

/** The full date and time, for the timestamp's tooltip. */
export function messageDateTime(timestamp: number, locale?: string): string {
  return new Date(timestamp).toLocaleString(locale, { weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" });
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

/**
 * Dividers for a timeline whose entries are messages (a timestamp) or tool
 * runs (undefined). A tool run belongs to the day of the message it leads
 * into, so a divider never lands between a run and its reply; trailing runs
 * take `now`.
 */
export function dayDividers(stamps: readonly (number | undefined)[], now = Date.now(), locale?: string): (string | null)[] {
  const days = new Array<number>(stamps.length);
  let upcoming = now;
  for (let i = stamps.length - 1; i >= 0; i--) { upcoming = stamps[i] ?? upcoming; days[i] = upcoming; }
  return days.map((day, i) => dividerBefore(i ? days[i - 1] : undefined, day, now, locale));
}
