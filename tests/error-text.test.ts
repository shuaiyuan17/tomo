import { describe, expect, it } from "vitest";
import { describeError, safeJson } from "../src/error-text.js";
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

  it("bounds the length", () => {
    expect(describeError("x".repeat(5000)).length).toBe(2000);
  });
});

describe("partial-delivery errors", () => {
  it("describe a structured failure instead of [object Object]", () => {
    const failure = { code: -32004, message: "Mutation lane blocked" };
    expect(new PartialSendError(failure, { photo: true }).message)
      .toBe('Send partly delivered: {"code":-32004,"message":"Mutation lane blocked"}');
    expect(new PartialDeliveryError(failure, [{ text: "a", delivered: true }, { text: "b", delivered: false }]).message)
      .toContain('— {"code":-32004,"message":"Mutation lane blocked"}');
  });
});
