/**
 * Guards for B-LANG-DETECTOR + B-LANG-DORMANT.
 *
 * B-LANG-DETECTOR: the detector was first-match-wins on a single keyword, and some hint
 * words are English-ambiguous ("configuration" in fr, "error" in es) → English text
 * misclassified as fr/es. Now it is score-based and needs ≥2 hits to leave English.
 *
 * B-LANG-DORMANT: with autoDetectLanguage on but enabledPacks ["en"], detected non-English
 * text fell back to the English pack, whose `articles` rule deletes foreign articles
 * (pt-BR "a"/"o"). Auto-detect must use the detected pack (it always has rules).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectCompressionLanguage } from "@omniroute/open-sse/services/compression/languageDetector.ts";
import { cavemanCompress } from "@omniroute/open-sse/services/compression/caveman.ts";

test("detector ignores single English-ambiguous keywords (configuration/error)", () => {
  assert.equal(
    detectCompressionLanguage("Please update the configuration and fix the error in the file"),
    "en"
  );
});

test("detector still recognizes genuine non-English text (native keywords/scripts)", () => {
  assert.equal(detectCompressionLanguage("Por favor preciso do arquivo com erro"), "pt-BR");
  assert.equal(detectCompressionLanguage("これはテストですコードを確認"), "ja");
  assert.equal(detectCompressionLanguage("이 코드와 파일 오류를 확인해주세요"), "ko");
});

test("auto-detect uses the detected pt-BR pack, not the mangling English pack (B-LANG-DORMANT)", () => {
  // pt-BR prose with an article the English `articles` rule would delete ("a configuração").
  const text =
    "Por favor, você poderia revisar a configuração do arquivo? Obrigado pela ajuda com isso.";
  const res = cavemanCompress(
    { messages: [{ role: "user", content: text }] } as Record<string, unknown>,
    {
      enabled: true,
      autoDetectLanguage: true,
      enabledLanguagePacks: ["en"], // the production-default that used to force the English pack
      intensity: "full",
      compressRoles: ["user"],
      minMessageLength: 0,
    } as Record<string, unknown>
  );
  const rules = res.stats?.rulesApplied ?? [];
  // A pt-BR rule must have run (proves the pt-BR pack was selected, not English).
  assert.ok(
    rules.some((r) => r.startsWith("pt_")),
    `expected a pt_* rule to apply, got: ${JSON.stringify(rules)}`
  );
});

test("auto-detect uses the detected Korean pack even when enabledPacks only contains en", () => {
  const text = "안녕하세요 이 코드를 설명해주세요. 데이터베이스 인증 구현을 확인해주세요.";
  const res = cavemanCompress(
    { messages: [{ role: "user", content: text }] } as Record<string, unknown>,
    {
      enabled: true,
      autoDetectLanguage: true,
      enabledLanguagePacks: ["en"],
      intensity: "ultra",
      compressRoles: ["user"],
      minMessageLength: 0,
    } as Record<string, unknown>
  );
  const rules = res.stats?.rulesApplied ?? [];

  assert.ok(
    rules.some((r) => r.startsWith("ko_")),
    `expected a ko_* rule to apply, got: ${JSON.stringify(rules)}`
  );
});
