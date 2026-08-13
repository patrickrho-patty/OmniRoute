import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildCavemanOutputInstruction,
  detectCompressionLanguage,
  loadAllRulesForLanguage,
} from "../../../open-sse/services/compression/index.ts";
import { applyRulesToText } from "../../../open-sse/services/compression/caveman.ts";
import { getRulesForContext } from "../../../open-sse/services/compression/cavemanRules.ts";

const LANGUAGES = ["pt-BR", "es", "de", "fr", "ja", "id", "ko"];

describe("Caveman language packs", () => {
  it("ships 7 language packs with at least 15 rules each", () => {
    for (const language of LANGUAGES) {
      const rules = loadAllRulesForLanguage(language, { refresh: true });
      assert.ok(rules.length >= 15, `${language} expected 15+ rules, got ${rules.length}`);
      assert.ok(
        rules.some((rule) => rule.category === "filler"),
        `${language} missing filler`
      );
      assert.ok(
        rules.some((rule) => rule.category === "context"),
        `${language} missing context`
      );
      assert.ok(
        rules.some((rule) => rule.category === "structural"),
        `${language} missing structural`
      );
    }
  });

  it("detects supported languages", () => {
    assert.equal(detectCompressionLanguage("preciso corrigir este arquivo com erro"), "pt-BR");
    assert.equal(detectCompressionLanguage("necesito corregir este archivo con error"), "es");
    assert.equal(detectCompressionLanguage("ich brauche diese konfiguration"), "de");
    assert.equal(detectCompressionLanguage("j'ai besoin de corriger cette erreur fichier"), "fr");
    assert.equal(detectCompressionLanguage("このコードを修正してください"), "ja");
    assert.equal(detectCompressionLanguage("bisa tolong jelaskan tentang database ini"), "id");
    assert.equal(
      detectCompressionLanguage("이 코드를 수정하고 데이터베이스 오류를 확인해주세요"),
      "ko"
    );
  });

  it("applies non-English rule packs to golden samples", () => {
    const ptRules = getRulesForContext("user", "full", "pt-BR");
    const { text } = applyRulesToText("por favor segue o código: const auth = true", ptRules);

    assert.ok(!text.toLowerCase().includes("por favor"));
    assert.ok(text.includes("Código:"));
    assert.ok(text.includes("auth"));
  });

  it("keeps the Spanish pack aligned with English rule categories", () => {
    const esRules = loadAllRulesForLanguage("es", { refresh: true });
    assert.ok(esRules.length >= 40, `es expected 40+ rules, got ${esRules.length}`);
    assert.ok(
      esRules.some((rule) => rule.category === "dedup"),
      "es missing dedup"
    );
    assert.ok(
      esRules.some((rule) => rule.category === "ultra"),
      "es missing ultra"
    );
    assert.ok(
      esRules.some((rule) => rule.category === "terse"),
      "es missing terse"
    );
  });

  it("applies expanded Spanish rules without touching technical terms", () => {
    const esRules = getRulesForContext("user", "ultra", "es");
    const { text } = applyRulesToText(
      "Por favor proporciona una explicación detallada de la base de datos y autenticación en src/auth.ts",
      esRules
    );

    assert.ok(!text.toLowerCase().includes("por favor"));
    assert.ok(!text.toLowerCase().includes("explicación detallada"));
    assert.ok(text.includes("BD"));
    assert.ok(text.includes("auth"));
    assert.ok(text.includes("src/auth.ts"));
  });

  it("applies Indonesian rules without touching technical terms", () => {
    const idRules = getRulesForContext("user", "ultra", "id");
    const { text } = applyRulesToText(
      "Tolong berikan penjelasan detail tentang basis data dan autentikasi di src/auth.ts",
      idRules
    );

    assert.ok(!text.toLowerCase().includes("tolong"));
    assert.ok(!text.toLowerCase().includes("penjelasan detail"));
    assert.ok(text.includes("DB"));
    assert.ok(text.includes("auth"));
    assert.ok(text.includes("src/auth.ts"));
  });

  it("applies Korean rules translated from the Japanese pack", () => {
    const koRules = getRulesForContext("user", "ultra", "ko");
    const { text } = applyRulesToText(
      "안녕하세요 이 코드를 설명해주세요. 데이터베이스와 인증 구현을, 권한 부여를 확인해주세요 src/auth.ts",
      koRules
    );

    assert.ok(!text.includes("안녕하세요"));
    assert.ok(!text.startsWith(" "), text);
    assert.ok(text.includes("코드:"));
    assert.ok(!text.includes("코드:를"), text);
    assert.ok(text.includes("DB"));
    assert.ok(text.includes("auth"));
    assert.ok(text.includes("impl"));
    assert.ok(!text.includes("impl을"), text);
    assert.ok(text.includes("authz"));
    assert.ok(text.includes("src/auth.ts"));
  });

  it("does not rewrite common Korean question endings as authorization", () => {
    const koRules = getRulesForContext("user", "ultra", "ko");
    const { text } = applyRulesToText("이게 권한 버그인가요", koRules);

    assert.ok(text.includes("버그인가요"), text);
    assert.ok(!text.includes("authz요"), text);
  });

  it("consumes Korean particles around compact labels and authz abbreviations", () => {
    const koRules = getRulesForContext("user", "ultra", "ko");
    const { text } = applyRulesToText(
      "아래 코드를 수정하기 위해서 데이터베이스 설정과 접근 권한을 확인해주세요",
      koRules
    );

    assert.ok(text.includes("코드:"), text);
    assert.ok(!text.includes("코드:를"), text);
    assert.ok(text.includes("수정 위해"), text);
    assert.ok(text.includes("authz"), text);
    assert.ok(!text.includes("authz을"), text);
  });

  it("removes full English gratitude phrases before shorter pleasantries", () => {
    const enRules = getRulesForContext("user", "ultra", "en");
    const { text } = applyRulesToText("Thank you so much. Please explain the database.", enRules);

    assert.ok(!text.toLowerCase().includes("thank you"), text);
    assert.ok(!text.toLowerCase().includes("so much"), text);
    assert.ok(text.includes("DB"), text);
  });

  it("builds localized output mode instructions", () => {
    const config = { enabled: true, intensity: "full" as const, autoClarity: true };

    assert.match(buildCavemanOutputInstruction(config, "pt-BR"), /Responda/);
    assert.match(buildCavemanOutputInstruction(config, "es"), /Responde/);
    assert.match(buildCavemanOutputInstruction(config, "de"), /Antworte/);
    assert.match(buildCavemanOutputInstruction(config, "fr"), /Reponds/);
    assert.match(buildCavemanOutputInstruction(config, "ja"), /回答/);
    assert.match(buildCavemanOutputInstruction(config, "id"), /Jawab/);
    assert.match(buildCavemanOutputInstruction(config, "ko"), /답변/);
  });
});
