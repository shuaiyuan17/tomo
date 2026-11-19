import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { pinOwnerFirst } from "../web/src/session-order.js";

const s = (id: string) => ({ id, title: id });
const ids = (list: Array<{ id: string }>) => list.map((x) => x.id);

describe("session picker order: the main session first", () => {
  it("moves the owner session to the top when the catalog lists it last", () => {
    const sessions = [s("g-climb"), s("g-books"), s("g-family"), s("owner")];
    expect(ids(pinOwnerFirst(sessions, "owner"))).toEqual(["owner", "g-climb", "g-books", "g-family"]);
  });

  it("moves it from the middle and keeps every other session in its original order", () => {
    const sessions = [s("g3"), s("g1"), s("owner"), s("g2"), s("g0")];
    expect(ids(pinOwnerFirst(sessions, "owner"))).toEqual(["owner", "g3", "g1", "g2", "g0"]);
  });

  it("leaves an already-first owner and the rest untouched", () => {
    const sessions = [s("owner"), s("b"), s("a")];
    expect(ids(pinOwnerFirst(sessions, "owner"))).toEqual(["owner", "b", "a"]);
  });

  it("keeps the order when there is no owner or the owner is not listed", () => {
    const sessions = [s("b"), s("a")];
    expect(ids(pinOwnerFirst(sessions, null))).toEqual(["b", "a"]);
    expect(ids(pinOwnerFirst(sessions, undefined))).toEqual(["b", "a"]);
    expect(ids(pinOwnerFirst(sessions, "owner"))).toEqual(["b", "a"]);
    expect(pinOwnerFirst([], "owner")).toEqual([]);
  });

  it("returns a new array and never mutates the input", () => {
    const sessions = [s("a"), s("owner")];
    const out = pinOwnerFirst(sessions, "owner");
    expect(out).not.toBe(sessions);
    expect(ids(sessions)).toEqual(["a", "owner"]);
    expect(out[0]).toBe(sessions[1]);
  });

  it("the picker renders the pinned list, not the raw catalog order", () => {
    const main = readFileSync(new URL("../web/src/sidebar.tsx", import.meta.url), "utf8");
    expect(main).toMatch(/pinOwnerFirst\(sessions, ownerId\)/);
    expect(main).toMatch(/pickerSessions\.map\(/);
    expect(main).not.toMatch(/\{sessions\.map\(\(s\) => <DropdownMenuRadioItem/);
  });
});
