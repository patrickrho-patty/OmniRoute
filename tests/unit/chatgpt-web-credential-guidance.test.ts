import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { getWebSessionCredentialHint } from "../../src/app/(dashboard)/dashboard/providers/[id]/providerCredentialText.ts";
import { validateChatGptWebProvider } from "../../src/lib/providers/validation/chatgptWeb.ts";
import { WEB_SESSION_CREDENTIAL_REQUIREMENTS } from "../../src/shared/providers/webSessionCredentials.ts";

import type { ProviderMessageTranslator } from "../../src/app/(dashboard)/dashboard/providers/[id]/providerCredentialText.ts";

/**
 * The ChatGPT Web (Clean Room) credential field contradicted itself: it was labelled
 * "Playwright storage-state JSON" while the generic hint said "Paste the Cookie header value…",
 * and the validator rejects a header without the session cookie. Operators pasted a Cookie
 * header (which the server does accept) and were told the credential was missing/invalid.
 *
 * These tests pin both halves: the guidance names the format that actually works, and a
 * rejection explains itself instead of blaming "foreign origins".
 */

// A translator that resolves nothing, so provider fallbacks are exercised verbatim.
const untranslated = Object.assign(((key: string) => key) as ProviderMessageTranslator, {
  has: () => false,
});

const requirement = WEB_SESSION_CREDENTIAL_REQUIREMENTS["chatgpt-web"];

const SESSION_COOKIE_HEADER =
  "__Secure-next-auth.session-token=abc123; cf_clearance=xyz; oai-did=did-1";

describe("chatgpt-web credential guidance", () => {
  it("accepts a full Cookie header, matching what the validator does", () => {
    assert.equal(requirement.acceptsFullCookieHeader, true);
  });

  it("names both accepted formats instead of only storage-state JSON", () => {
    assert.match(requirement.credentialName, /cookie header/i);
    assert.match(requirement.credentialName, /storage-state/i);
  });

  it("tells the operator which cookie is mandatory", () => {
    assert.match(requirement.hintFallback ?? "", /__Secure-next-auth\.session-token/);
  });

  it("shows that provider-specific guidance instead of the generic cookie template", () => {
    const hint = getWebSessionCredentialHint(
      untranslated,
      requirement,
      "ChatGPT Web (Clean Room)",
      false
    );
    assert.ok(hint, "a hint must be rendered");
    assert.match(hint, /__Secure-next-auth\.session-token/);
    // The generic template's giveaway line, which never applied to this provider.
    assert.doesNotMatch(hint, /Do not include the Cookie: prefix/);
  });
});

describe("chatgpt-web credential validation", () => {
  it("accepts a Cookie header that carries the session token", () => {
    assert.deepEqual(validateChatGptWebProvider({ apiKey: SESSION_COOKIE_HEADER }), {
      valid: true,
      error: null,
      unsupported: false,
    });
  });

  it("accepts a Cookie: prefixed header too", () => {
    const result = validateChatGptWebProvider({ apiKey: `Cookie: ${SESSION_COOKIE_HEADER}` });
    assert.equal(result.valid, true);
  });

  it("rejects a header without the session cookie and says which one is missing", () => {
    const result = validateChatGptWebProvider({ apiKey: "cf_clearance=xyz; oai-did=did-1" });
    assert.equal(result.valid, false);
    assert.match(result.error ?? "", /session-token/);
  });

  it("explains an invalid storage-state cookie instead of blaming foreign origins", () => {
    const result = validateChatGptWebProvider({
      apiKey: JSON.stringify({
        cookies: [{ name: "a", value: "b", domain: ".chatgpt.com", path: "/" }],
        origins: [],
      }),
    });
    assert.equal(result.valid, false);
    assert.match(result.error ?? "", /invalid cookie/i);
    assert.doesNotMatch(result.error ?? "", /foreign origins/);
  });

  it("still rejects a foreign cookie domain, and says so", () => {
    const result = validateChatGptWebProvider({
      apiKey: JSON.stringify({
        cookies: [
          {
            name: "a",
            value: "b",
            domain: ".evil.example",
            path: "/",
            expires: -1,
            httpOnly: true,
            secure: true,
            sameSite: "Lax",
          },
        ],
        origins: [],
      }),
    });
    assert.equal(result.valid, false);
    assert.match(result.error ?? "", /foreign cookie domain/);
  });

  it("accepts a complete storage-state JSON", () => {
    const result = validateChatGptWebProvider({
      apiKey: JSON.stringify({
        cookies: [
          {
            name: "__Secure-next-auth.session-token",
            value: "abc",
            domain: ".chatgpt.com",
            path: "/",
            expires: -1,
            httpOnly: true,
            secure: true,
            sameSite: "Lax",
          },
        ],
        origins: [{ origin: "https://chatgpt.com", localStorage: [] }],
      }),
    });
    assert.equal(result.valid, true);
  });
});
