import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
const fake = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: fake.spawn }));
import { dispatchWebRestart } from "../src/web/restart.js";
it.each([1, 0, null])("observes restart worker exit after acknowledging spawn (code %s)", async (code) => {
  const child = Object.assign(new EventEmitter(), { unref: vi.fn() }); fake.spawn.mockReturnValue(child);
  const exited = vi.fn(); const dispatch = dispatchWebRestart("Reviewed settings", exited);
  child.emit("spawn"); await dispatch;
  expect(exited).not.toHaveBeenCalled(); expect(child.unref).toHaveBeenCalledOnce();
  child.emit("exit", code, code === null ? "SIGTERM" : null);
  expect(exited).toHaveBeenCalledExactlyOnceWith(code !== 0);
});
it("rejects restart worker startup errors", async () => {
  const child = Object.assign(new EventEmitter(), { unref: vi.fn() }); fake.spawn.mockReturnValue(child);
  const exited = vi.fn(); const dispatch = dispatchWebRestart("Reviewed settings", exited);
  const error = new Error("Synthetic spawn failure"); child.emit("error", error);
  await expect(dispatch).rejects.toBe(error);
});
