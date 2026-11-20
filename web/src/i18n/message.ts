import type { ParseKeys } from "i18next";
import { i18n } from "./index.js";
import type { WebResources } from "./resources.js";

/** Every key of the web catalogs, namespaced ("chat:composer.sending"). */
export type MessageKey = Extract<ParseKeys<(keyof WebResources)[]>, `${string}:${string}`>;

/**
 * Copy the page keeps in state (a status note, an error under a card, an
 * upload's failure): what to say and with what values, not the words. It is
 * translated when shown (`say`), so switching language re-words it at once.
 * Never put translated text in state.
 */
export interface Message { readonly key: MessageKey; readonly values?: Readonly<Record<string, string | number>> }

/**
 * `deferred.t(key, values)`: the same call as `i18n.t`, kept for later. It
 * returns the Message to store; `say` words it when it is shown.
 */
export const deferred = {
  t(key: MessageKey, values?: Record<string, string | number>): Message {
    return values ? { key, values } : { key };
  },
};

const translate = i18n.t.bind(i18n) as unknown as (key: string, values?: Record<string, unknown>) => string;

/** A message in the current language; "" for none. */
export function say(text: Message | null | undefined): string {
  return text ? translate(text.key, text.values) : "";
}
