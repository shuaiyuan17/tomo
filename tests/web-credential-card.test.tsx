import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CredentialCard, credentialError, timeLeft } from "../web/src/credential-card.js";
import { submitCredential, type WebBootstrap } from "../web/src/api.js";

const request = { id: "4f1c2a9e-0000-4000-8000-000000000001", name: "github", purpose: "push to my repo", expiresAt: Date.now() + 120_000 };
const bootstrap = { epoch: "e0e0e0e0-0000-4000-8000-000000000000", csrfToken: "csrf" } as unknown as WebBootstrap;

afterEach(() => { vi.unstubAllGlobals(); });

describe("the credential card", () => {
  it("is a password field the browser does not fill or remember, and shows name and unverified purpose only", () => {
    const html = renderToStaticMarkup(createElement(CredentialCard, { request, bootstrap, refresh: async () => bootstrap }));
    expect(html).toContain('type="password"');
    expect(html).toMatch(/autocomplete="off"/i);
    expect(html).toContain("github");
    expect(html).toContain("push to my repo");
    expect(html).toContain("not verified");
    expect(html).not.toMatch(/value="/);
  });

  it("answers on its own route, never /messages, with CSRF and the epoch", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ status: "stored" }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    await expect(submitCredential(request.id, { value: "fake-card-value" }, bootstrap, async () => bootstrap)).resolves.toEqual({ status: "stored" });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`/api/v1/credentials/${request.id}`);
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ "x-tomo-csrf": "csrf", "x-tomo-epoch": bootstrap.epoch });
  });

  it("words the daemon's fixed refusal codes, and counts down", () => {
    expect(credentialError("credential_expired")).toContain("expired");
    expect(credentialError("credential_unknown")).toContain("no longer open");
    expect(credentialError("invalid_value")).toContain("printable ASCII");
    expect(credentialError("whatever")).toBe("Could not send. Try again.");
    expect(timeLeft(1_000 + 125_000, 1_000)).toBe("2:05");
    expect(timeLeft(0, 5_000)).toBe("0:00");
  });
});
