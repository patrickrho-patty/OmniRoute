import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

// #6148 follow-up — the lazy-decrypting connection proxies (the path behind
// getProviderConnections → connection-test / auth selection) must expose
// `credentialDecryptFailed` when a stored credential is `enc:v1:` ciphertext
// that can no longer be decrypted — the unset-STORAGE_ENCRYPTION_KEY dev-server
// regression where every web provider's validation misreported "cookie expired"
// because the credential silently decrypted to null.
//
// The proxies import the CANONICAL encryption module (no query-bust), so this
// file controls the env BEFORE the first import and never re-imports under a
// different key — the module-level key cache in encryption.ts would otherwise
// make results order-dependent.

const ORIGINAL_STORAGE_KEY = process.env.STORAGE_ENCRYPTION_KEY;

test.before(() => {
  // Unset key = the regression state: ciphertext present, key gone.
  delete process.env.STORAGE_ENCRYPTION_KEY;
});

test.after(() => {
  if (ORIGINAL_STORAGE_KEY === undefined) {
    delete process.env.STORAGE_ENCRYPTION_KEY;
  } else {
    process.env.STORAGE_ENCRYPTION_KEY = ORIGINAL_STORAGE_KEY;
  }
});

async function importLazyView() {
  const url = pathToFileURL(path.resolve("src/lib/db/providers/lazyConnectionView.ts")).href;
  return import(`${url}?lazyflag=${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

const CIPHERTEXT =
  "enc:v1:0123456789abcdef:0123456789abcdef0123456789abcdef:0123456789abcdef0123456789abcdef";

test("createLazyRowProxy flags undecryptable ciphertext and nulls the credential", async () => {
  const { createLazyRowProxy } = await importLazyView();
  const proxy = createLazyRowProxy({
    id: "conn-1",
    provider: "chatgpt-web",
    apiKey: CIPHERTEXT,
  });

  assert.equal(proxy.apiKey, null, "ciphertext with no key must decrypt to null");
  assert.equal(
    proxy.credentialDecryptFailed,
    true,
    "lazy proxy must surface credentialDecryptFailed"
  );
});

test("createLazyRowProxy does not flag plaintext or empty credentials", async () => {
  const { createLazyRowProxy } = await importLazyView();

  const plain = createLazyRowProxy({
    id: "conn-2",
    provider: "openai",
    apiKey: "sk-plaintext-install",
  });
  assert.equal(plain.apiKey, "sk-plaintext-install");
  assert.notEqual(plain.credentialDecryptFailed, true);

  const empty = createLazyRowProxy({ id: "conn-3", provider: "openai", apiKey: null });
  assert.notEqual(empty.credentialDecryptFailed, true);
});

test("createLazyRowProxy flags when only the refreshToken is undecryptable", async () => {
  const { createLazyRowProxy } = await importLazyView();
  const proxy = createLazyRowProxy({
    id: "conn-4",
    provider: "codex",
    refreshToken: CIPHERTEXT,
  });
  assert.equal(proxy.credentialDecryptFailed, true);
});

test("createLazyConnectionView (typed) also flags undecryptable credentials", async () => {
  const { createLazyConnectionView } = await importLazyView();
  const view = createLazyConnectionView({
    id: "conn-5",
    provider: "claude-web",
    apiKey: CIPHERTEXT,
  });
  assert.equal(view.apiKey, null);
  assert.equal(view.credentialDecryptFailed, true);
});
