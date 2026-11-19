/**
 * The order of the session picker: the owner's own conversation (the main
 * session) always comes first, and every other session keeps the order the
 * catalog gave it. Returns a new array; the input is never mutated. With no
 * owner, or an owner id that is not in the list, the order is unchanged.
 */
export function pinOwnerFirst<T extends { id: string }>(sessions: readonly T[], ownerId: string | null | undefined): T[] {
  const owner = ownerId ? sessions.find((s) => s.id === ownerId) : undefined;
  if (!owner) return [...sessions];
  return [owner, ...sessions.filter((s) => s !== owner)];
}
