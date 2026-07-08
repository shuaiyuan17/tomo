import { describe, it, expect, vi } from "vitest";
import { ChatDbServiceLookup, NULL_SERVICE_LOOKUP, type SqliteModule } from "../src/channels/imsg-satellite.js";

// A mock node:sqlite layer that records prepare()/get() calls so we can assert
// the resolver prepares one statement and caches (LRU) instead of re-querying.
function mockSqlite(rows: Record<string, string>) {
  const gets: string[] = [];
  let prepareCount = 0;
  let closed = false;
  const module: SqliteModule = {
    DatabaseSync: class {
      constructor(public path: string, public options?: { readOnly?: boolean }) {}
      prepare(_sql: string) {
        prepareCount++;
        return {
          get: (guid: unknown) => {
            gets.push(String(guid));
            const service = rows[String(guid)];
            return service ? { service } : undefined;
          },
        };
      }
      close() {
        closed = true;
      }
    },
  };
  return { module, gets, closed: () => closed, prepareCount: () => prepareCount };
}

describe("ChatDbServiceLookup", () => {
  it("resolves message.service by guid via one prepared statement", () => {
    const sqlite = mockSqlite({ "g-lite": "iMessageLite", "g-im": "iMessage" });
    const lookup = new ChatDbServiceLookup("/fake/chat.db", { loadSqlite: () => sqlite.module });

    expect(lookup.serviceForGuid("g-lite")).toBe("iMessageLite");
    expect(lookup.serviceForGuid("g-im")).toBe("iMessage");
    expect(lookup.serviceForGuid("g-missing")).toBeUndefined();

    // Statement is prepared exactly once and reused across queries.
    expect(sqlite.prepareCount()).toBe(1);
    expect(sqlite.gets).toEqual(["g-lite", "g-im", "g-missing"]);
    lookup.close();
  });

  it("caches results so a repeated guid never re-hits sqlite", () => {
    const sqlite = mockSqlite({ "g-lite": "iMessageLite" });
    const lookup = new ChatDbServiceLookup("/fake/chat.db", { loadSqlite: () => sqlite.module });

    expect(lookup.serviceForGuid("g-lite")).toBe("iMessageLite");
    expect(lookup.serviceForGuid("g-lite")).toBe("iMessageLite");
    expect(lookup.serviceForGuid("g-lite")).toBe("iMessageLite");

    expect(sqlite.gets).toEqual(["g-lite"]); // one sqlite hit, two cache hits
    lookup.close();
  });

  it("caches negative (unknown-service) results too", () => {
    const sqlite = mockSqlite({});
    const lookup = new ChatDbServiceLookup("/fake/chat.db", { loadSqlite: () => sqlite.module });

    expect(lookup.serviceForGuid("g-x")).toBeUndefined();
    expect(lookup.serviceForGuid("g-x")).toBeUndefined();
    expect(sqlite.gets).toEqual(["g-x"]); // second call served from cache
    lookup.close();
  });

  it("evicts the least-recently-used entry past maxCache", () => {
    const sqlite = mockSqlite({ "a": "iMessage", "b": "iMessage", "c": "iMessage" });
    const lookup = new ChatDbServiceLookup("/fake/chat.db", { loadSqlite: () => sqlite.module, maxCache: 2 });

    lookup.serviceForGuid("a");
    lookup.serviceForGuid("b");
    lookup.serviceForGuid("c"); // evicts "a" (LRU)
    lookup.serviceForGuid("a"); // re-queried

    expect(sqlite.gets).toEqual(["a", "b", "c", "a"]);
    lookup.close();
  });

  it("degrades to undefined (never throws) when the database cannot be opened", () => {
    const lookup = new ChatDbServiceLookup("/fake/chat.db", {
      loadSqlite: () => { throw new Error("no Full Disk Access"); },
    });
    expect(lookup.serviceForGuid("g-lite")).toBeUndefined();
    // Failure is sticky — it does not retry (and does not throw) on later calls.
    expect(lookup.serviceForGuid("g-im")).toBeUndefined();
    lookup.close();
  });

  it("degrades to undefined when a query throws", () => {
    const module: SqliteModule = {
      DatabaseSync: class {
        constructor(public path: string) {}
        prepare() {
          return { get: () => { throw new Error("db locked"); } };
        }
        close() {}
      },
    };
    const lookup = new ChatDbServiceLookup("/fake/chat.db", { loadSqlite: () => module });
    expect(lookup.serviceForGuid("g-lite")).toBeUndefined();
    lookup.close();
  });

  it("returns undefined for an empty guid without opening the database", () => {
    const load = vi.fn();
    const lookup = new ChatDbServiceLookup("/fake/chat.db", { loadSqlite: load });
    expect(lookup.serviceForGuid("")).toBeUndefined();
    expect(load).not.toHaveBeenCalled();
    lookup.close();
  });

  it("closes the database and clears the cache on close()", () => {
    const sqlite = mockSqlite({ "g-lite": "iMessageLite" });
    const lookup = new ChatDbServiceLookup("/fake/chat.db", { loadSqlite: () => sqlite.module });
    lookup.serviceForGuid("g-lite");
    lookup.close();
    expect(sqlite.closed()).toBe(true);
  });
});

describe("NULL_SERVICE_LOOKUP", () => {
  it("never resolves a service", () => {
    expect(NULL_SERVICE_LOOKUP.serviceForGuid("anything")).toBeUndefined();
    NULL_SERVICE_LOOKUP.close();
  });
});
