// Reproduce + verify fix for the "every web provider says cookie expired" regression.
//
// Root cause: repo .env had STORAGE_ENCRYPTION_KEY empty while all stored
// credentials were `enc:v1:` ciphertext → decrypt() returned null/ciphertext →
// validators probed upstream with an empty/garbage cookie → misreported
// "session expired" for every web provider.
//
// Fix (#6148 follow-up): decryptConnectionFields + the lazy proxies flag
// `credentialDecryptFailed`, and testSingleConnection short-circuits with the
// honest STALE_ENCRYPTION_MESSAGE instead of probing upstream.
//
// Usage:
//   node --import tsx/esm scripts/ad-hoc/repro-web-cookie-validation.ts            # no key (regression state)
//   STORAGE_ENCRYPTION_KEY=$(grep ^STORAGE_ENCRYPTION_KEY= ~/.omniroute/.env | cut -d= -f2) \
//     node --import tsx/esm scripts/ad-hoc/repro-web-cookie-validation.ts          # key restored
import { getProviderConnections } from "../../src/lib/db/providers.ts";
import { validateChatGptWebProvider } from "../../src/lib/providers/validation/webProvidersA.ts";
import {
  isStaleEncryptionConnection,
  STALE_ENCRYPTION_MESSAGE,
} from "../../src/app/api/providers/[id]/models/staleEncryptionGuard.ts";

const conns = await getProviderConnections();
const conn: any = conns.find((c: any) => c.provider === "chatgpt-web");
if (!conn) {
  console.log("NO chatgpt-web connection found");
  process.exit(0);
}
console.log("connection id:", conn.id, "| apiKey length:", conn.apiKey?.length ?? 0);
console.log(
  "credentialDecryptFailed flag:",
  conn.credentialDecryptFailed === undefined ? "(absent)" : conn.credentialDecryptFailed
);

// What testSingleConnection now does BEFORE any upstream probe:
if (isStaleEncryptionConnection(conn)) {
  console.log("\ntestSingleConnection → SHORT-CIRCUITS with the honest error:");
  console.log("  ", STALE_ENCRYPTION_MESSAGE);
  console.log("(no upstream request made — no false 'cookie expired' verdict)");
  process.exit(0);
}

console.log("\nflag clear — validator runs normally:");
const result = await validateChatGptWebProvider({ apiKey: conn.apiKey });
console.log("VALIDATOR RESULT:", JSON.stringify(result, null, 2));
process.exit(0);
