import { createContext, useContext, useSyncExternalStore } from "react";
import type { WebSession, WebSubsession } from "../../src/web/protocol.js";

/**
 * What an activity card needs from outside its row: the conversations by id
 * (to name a send_message's destination), which conversation is open, and a
 * way to open a task in the Tasks rail. Given by main.tsx; a card outside it
 * (a test, a subagent's transcript) gets the defaults and names nothing.
 */
export interface ActivityEnv {
  sessions: readonly WebSession[];
  /** The conversation the chat shows. */
  sessionId?: string;
  /** It is the owner's own conversation. */
  ownerConversation?: boolean;
  /** Opens the Tasks rail on that sub-session; absent where there is no rail. */
  openTask?: (id: string) => void;
}
const NO_ENV: ActivityEnv = { sessions: [] };
const Env = createContext<ActivityEnv>(NO_ENV);
export const ActivityEnvProvider = Env.Provider;
export function useActivityEnv(): ActivityEnv { return useContext(Env); }

/**
 * The owner's sub-sessions, by id, for the task_spawn card's live footer.
 * Kept in a tiny external store rather than passed down: history rows are
 * memoised, and a task changing must re-render only the cards that show it,
 * not every row (useSyncExternalStore with a per-id snapshot).
 */
let tasks = new Map<string, WebSubsession>();
let loaded = false;
const listeners = new Set<() => void>();
export function publishSubsessions(list: readonly WebSubsession[], isLoaded = true): void {
  const next = new Map(list.map((task) => [task.id, task]));
  // Keep an unchanged task's object, so its card does not re-render for another task's change.
  for (const [id, task] of next) { const old = tasks.get(id); if (old && JSON.stringify(old) === JSON.stringify(task)) next.set(id, old); }
  tasks = next; loaded = isLoaded;
  for (const listener of listeners) listener();
}
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
/** The task with this id: undefined until the list has loaded, null when it is not in it (archived, or older than the rail keeps). */
export function useSubsessionById(id: string | undefined): WebSubsession | null | undefined {
  const read = () => !loaded ? undefined : id ? tasks.get(id) ?? null : null;
  return useSyncExternalStore(subscribe, read, read);
}
