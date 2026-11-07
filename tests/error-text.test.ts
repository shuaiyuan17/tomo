import { describe, expect, it } from "vitest";
import { describeError, safeJson, shortErrorMessage } from "../src/error-text.js";
import { PartialDeliveryError } from "../src/agent/delivery-pipeline.js";
import { PartialSendError } from "../src/channels/types.js";

describe("describeError", () => {
  it("never renders a plain object as [object Object]", () => {
    expect(describeError({ lane: "send", busy: true })).toBe('{"lane":"send","busy":true}');
  });

  it("keeps an Error's message and appends code, signal, exit code and stderr", () => {
    const err = Object.assign(new Error("Command failed: imsg status --json"), {
      code: 1, signal: null, stderr: Buffer.from("bridge not injected\n"),
    });
    expect(describeError(err)).toBe("Command failed: imsg status --json (code=1, stderr=bridge not injected)");
    const spawn = Object.assign(new Error("spawn imsg ENOENT"), { code: "ENOENT", errno: -2, syscall: "spawn imsg" });
    expect(describeError(spawn)).toBe("spawn imsg ENOENT (code=ENOENT, errno=-2, syscall=spawn imsg)");
  });

  it("serializes structured fields on an Error", () => {
    const err = Object.assign(new Error("Mutation lane blocked"), { data: { lane: "send" } });
    expect(describeError(err)).toBe('Mutation lane blocked (data={"lane":"send"})');
  });

  it("passes strings through and survives cycles, BigInt and nullish values", () => {
    expect(describeError("boom")).toBe("boom");
    expect(describeError(undefined)).toBe("undefined");
    const cyclic: Record<string, unknown> = { n: 1n };
    cyclic.self = cyclic;
    expect(safeJson(cyclic)).toBe('{"n":"1","self":"[circular]"}');
  });

  it("bounds the length, keeping the fields and the END of stderr", () => {
    expect(describeError("x".repeat(5000)).length).toBe(2000);
    const stderr = `${"noise ".repeat(1000)}FATAL: bridge not injected`;
    const err = Object.assign(new Error(`Command failed: imsg status --json\n${stderr}`), { code: 1, stderr });
    const text = describeError(err);
    expect(text.length).toBeLessThanOrEqual(2000);
    expect(text).toContain("code=1");
    expect(text).toContain("FATAL: bridge not injected)");
  });

  it("never throws, whatever the value's getters do", () => {
    const hostile = new Error("send failed");
    Object.defineProperty(hostile, "code", { get() { throw new Error("getter"); }, enumerable: true });
    expect(describeError(hostile)).toBe("send failed");
    const obj = { get boom() { throw new Error("getter"); } };
    expect(describeError(obj)).toBe("(unserializable object)");
    expect(describeError(Buffer.from("plain text"))).toBe("plain text");
  });
});

describe("partial-delivery errors", () => {
  it("carry the short message (it can be shown) and keep the full detail for the log", () => {
    const failure = Object.assign(new Error("Mutation lane blocked"), { code: -32004, stderr: "secret stderr" });
    const send = new PartialSendError(failure, { photo: true });
    expect(send.message).toBe("Send partly delivered: Mutation lane blocked");
    expect(send.detail).toBe("Mutation lane blocked (code=-32004, stderr=secret stderr)");
    const block = new PartialDeliveryError(failure, [{ text: "a", delivered: true }, { text: "b", delivered: false }]);
    expect(block.message).toBe("Block partly delivered: 1 of 2 part(s) not known to have shipped — Mutation lane blocked");
    expect(block.detail).toContain("stderr=secret stderr");
    expect(new PartialSendError({ code: -32004, message: "lane busy" }, { photo: true }).message)
      .toBe("Send partly delivered: lane busy");
  });
});

describe("shortErrorMessage", () => {
  it("is the bare message, never stderr, RPC data or [object Object]", () => {
    const err = Object.assign(new Error("spawn imsg ENOENT"), { code: "ENOENT", stderr: "detail" });
    expect(shortErrorMessage(err)).toBe("spawn imsg ENOENT");
    expect(shortErrorMessage({ message: "refused", data: { x: 1 } })).toBe("refused");
    expect(shortErrorMessage({ lane: "send" })).toBe("unknown error (details are in the log)");
    expect(shortErrorMessage("plain")).toBe("plain");
    expect(shortErrorMessage(undefined)).toBe("unknown error");
  });

  it("prefers a channel's publicMessage over a message that carries protocol detail", () => {
    const rpc = Object.assign(new Error('imsg rpc send failed (-32004) Mutation lane blocked: {"lane":"send"}'),
      { publicMessage: "imsg rpc send failed (-32004) Mutation lane blocked" });
    expect(shortErrorMessage(rpc)).toBe("imsg rpc send failed (-32004) Mutation lane blocked");
  });

  it("keeps an Error's message whole (safeguard and recovery-hint matching read it) and never throws", () => {
    const long = new Error("x".repeat(3000));
    expect(shortErrorMessage(long)).toHaveLength(3000);
    const hostile = { get message() { throw new Error("getter"); } };
    expect(shortErrorMessage(hostile)).toBe("unknown error (details are in the log)");
  });
});
