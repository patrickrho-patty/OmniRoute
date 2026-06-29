"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Card } from "@/shared/components";
import { parseIntegerOrNull } from "@/shared/utils/envParsing";
import {
  CLAUDE_LARGE_MESSAGES_MODES,
  DEFAULT_CLAUDE_LARGE_MESSAGES_MAX_MB,
  DEFAULT_CLAUDE_LARGE_MESSAGES_MODE,
  DEFAULT_CLAUDE_LARGE_MESSAGES_TARGET_KB,
  DEFAULT_CLAUDE_LARGE_MESSAGES_THRESHOLD_KB,
  DEFAULT_REQUEST_BODY_LIMIT_MB,
  MAX_CLAUDE_LARGE_MESSAGES_MAX_MB,
  MAX_CLAUDE_LARGE_MESSAGES_TARGET_KB,
  MAX_CLAUDE_LARGE_MESSAGES_THRESHOLD_KB,
  MAX_REQUEST_BODY_LIMIT_MB,
  MIN_CLAUDE_LARGE_MESSAGES_MAX_MB,
  MIN_CLAUDE_LARGE_MESSAGES_TARGET_KB,
  MIN_CLAUDE_LARGE_MESSAGES_THRESHOLD_KB,
  MIN_REQUEST_BODY_LIMIT_MB,
  type ClaudeLargeMessagesMode,
} from "@/shared/constants/bodySize";
import { useTranslations } from "next-intl";

type Message = { type: "success" | "error"; text: string };

interface SettingsResponse {
  maxBodySizeMb?: number;
  claudeLargeMessagesMode?: ClaudeLargeMessagesMode;
  claudeLargeMessagesThresholdKb?: number;
  claudeLargeMessagesTargetKb?: number;
  claudeLargeMessagesMaxMb?: number;
  [key: string]: unknown;
}

function normalizeInputValue(value: unknown, fallback: number): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : String(fallback);
}

function normalizeModeValue(value: unknown): ClaudeLargeMessagesMode {
  return typeof value === "string" &&
    (CLAUDE_LARGE_MESSAGES_MODES as readonly string[]).includes(value)
    ? (value as ClaudeLargeMessagesMode)
    : DEFAULT_CLAUDE_LARGE_MESSAGES_MODE;
}

export default function RequestLimitsTab() {
  const t = useTranslations("settings");
  const [bodyLimitValue, setBodyLimitValue] = useState(String(DEFAULT_REQUEST_BODY_LIMIT_MB));
  const [savedBodyLimitValue, setSavedBodyLimitValue] = useState(
    String(DEFAULT_REQUEST_BODY_LIMIT_MB)
  );
  const [claudeMode, setClaudeMode] = useState<ClaudeLargeMessagesMode>(
    DEFAULT_CLAUDE_LARGE_MESSAGES_MODE
  );
  const [savedClaudeMode, setSavedClaudeMode] = useState<ClaudeLargeMessagesMode>(
    DEFAULT_CLAUDE_LARGE_MESSAGES_MODE
  );
  const [claudeThresholdKb, setClaudeThresholdKb] = useState(
    String(DEFAULT_CLAUDE_LARGE_MESSAGES_THRESHOLD_KB)
  );
  const [savedClaudeThresholdKb, setSavedClaudeThresholdKb] = useState(
    String(DEFAULT_CLAUDE_LARGE_MESSAGES_THRESHOLD_KB)
  );
  const [claudeTargetKb, setClaudeTargetKb] = useState(
    String(DEFAULT_CLAUDE_LARGE_MESSAGES_TARGET_KB)
  );
  const [savedClaudeTargetKb, setSavedClaudeTargetKb] = useState(
    String(DEFAULT_CLAUDE_LARGE_MESSAGES_TARGET_KB)
  );
  const [claudeMaxMb, setClaudeMaxMb] = useState(String(DEFAULT_CLAUDE_LARGE_MESSAGES_MAX_MB));
  const [savedClaudeMaxMb, setSavedClaudeMaxMb] = useState(
    String(DEFAULT_CLAUDE_LARGE_MESSAGES_MAX_MB)
  );
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);

  const applySettings = useCallback((settings: SettingsResponse) => {
    const nextBodyLimit = normalizeInputValue(
      settings.maxBodySizeMb,
      DEFAULT_REQUEST_BODY_LIMIT_MB
    );
    const nextClaudeMode = normalizeModeValue(settings.claudeLargeMessagesMode);
    const nextClaudeThresholdKb = normalizeInputValue(
      settings.claudeLargeMessagesThresholdKb,
      DEFAULT_CLAUDE_LARGE_MESSAGES_THRESHOLD_KB
    );
    const nextClaudeTargetKb = normalizeInputValue(
      settings.claudeLargeMessagesTargetKb,
      DEFAULT_CLAUDE_LARGE_MESSAGES_TARGET_KB
    );
    const nextClaudeMaxMb = normalizeInputValue(
      settings.claudeLargeMessagesMaxMb,
      DEFAULT_CLAUDE_LARGE_MESSAGES_MAX_MB
    );

    setBodyLimitValue(nextBodyLimit);
    setSavedBodyLimitValue(nextBodyLimit);
    setClaudeMode(nextClaudeMode);
    setSavedClaudeMode(nextClaudeMode);
    setClaudeThresholdKb(nextClaudeThresholdKb);
    setSavedClaudeThresholdKb(nextClaudeThresholdKb);
    setClaudeTargetKb(nextClaudeTargetKb);
    setSavedClaudeTargetKb(nextClaudeTargetKb);
    setClaudeMaxMb(nextClaudeMaxMb);
    setSavedClaudeMaxMb(nextClaudeMaxMb);
  }, []);

  useEffect(() => {
    let active = true;

    fetch("/api/settings")
      .then((response) => {
        if (!response.ok) throw new Error(`Settings API returned ${response.status}`);
        return response.json() as Promise<SettingsResponse>;
      })
      .then((settings) => {
        if (!active) return;
        applySettings(settings);
      })
      .catch((error) => {
        console.error("Failed to load request limit settings:", error);
        if (active) {
          setMessage({ type: "error", text: t("requestBodyLimitLoadFailed") });
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [applySettings, t]);

  const bodyLimitValidationError = useMemo(() => {
    const trimmed = bodyLimitValue.trim();
    if (!trimmed) return t("requestBodyLimitEmptyError");

    const parsed = Number(trimmed);
    if (!Number.isInteger(parsed)) return t("requestBodyLimitWholeNumberError");
    if (parsed < MIN_REQUEST_BODY_LIMIT_MB) {
      return t("requestBodyLimitMinimumError", { min: MIN_REQUEST_BODY_LIMIT_MB });
    }
    if (parsed > MAX_REQUEST_BODY_LIMIT_MB) {
      return t("requestBodyLimitMaximumError", { max: MAX_REQUEST_BODY_LIMIT_MB });
    }

    return null;
  }, [bodyLimitValue, t]);

  const claudeValidationError = useMemo(() => {
    const threshold = parseIntegerOrNull(claudeThresholdKb);
    if (threshold === null) return t("claudeLargeMessagesThresholdWholeNumberError");
    if (threshold < MIN_CLAUDE_LARGE_MESSAGES_THRESHOLD_KB) {
      return t("claudeLargeMessagesThresholdMinimumError", {
        min: MIN_CLAUDE_LARGE_MESSAGES_THRESHOLD_KB,
      });
    }
    if (threshold > MAX_CLAUDE_LARGE_MESSAGES_THRESHOLD_KB) {
      return t("claudeLargeMessagesThresholdMaximumError", {
        max: MAX_CLAUDE_LARGE_MESSAGES_THRESHOLD_KB,
      });
    }

    const target = parseIntegerOrNull(claudeTargetKb);
    if (target === null) return t("claudeLargeMessagesTargetWholeNumberError");
    if (target < MIN_CLAUDE_LARGE_MESSAGES_TARGET_KB) {
      return t("claudeLargeMessagesTargetMinimumError", {
        min: MIN_CLAUDE_LARGE_MESSAGES_TARGET_KB,
      });
    }
    if (target > MAX_CLAUDE_LARGE_MESSAGES_TARGET_KB) {
      return t("claudeLargeMessagesTargetMaximumError", {
        max: MAX_CLAUDE_LARGE_MESSAGES_TARGET_KB,
      });
    }
    if (target > threshold) {
      return t("claudeLargeMessagesTargetAboveThresholdError");
    }

    const maxMb = parseIntegerOrNull(claudeMaxMb);
    if (maxMb === null) return t("claudeLargeMessagesMaxWholeNumberError");
    if (maxMb < MIN_CLAUDE_LARGE_MESSAGES_MAX_MB) {
      return t("claudeLargeMessagesMaxMinimumError", {
        min: MIN_CLAUDE_LARGE_MESSAGES_MAX_MB,
      });
    }
    if (maxMb > MAX_CLAUDE_LARGE_MESSAGES_MAX_MB) {
      return t("claudeLargeMessagesMaxMaximumError", {
        max: MAX_CLAUDE_LARGE_MESSAGES_MAX_MB,
      });
    }
    if (maxMb * 1024 < target) {
      return t("claudeLargeMessagesMaxBelowTargetError");
    }

    return null;
  }, [claudeMaxMb, claudeTargetKb, claudeThresholdKb, t]);

  const validationError = bodyLimitValidationError ?? claudeValidationError;

  const dirty =
    bodyLimitValue.trim() !== savedBodyLimitValue ||
    claudeMode !== savedClaudeMode ||
    claudeThresholdKb.trim() !== savedClaudeThresholdKb ||
    claudeTargetKb.trim() !== savedClaudeTargetKb ||
    claudeMaxMb.trim() !== savedClaudeMaxMb;

  const saveLimit = useCallback(async () => {
    if (validationError || !dirty) return;

    const nextBodyLimit = Number(bodyLimitValue.trim());
    const nextClaudeThresholdKb = Number(claudeThresholdKb.trim());
    const nextClaudeTargetKb = Number(claudeTargetKb.trim());
    const nextClaudeMaxMb = Number(claudeMaxMb.trim());
    setSaving(true);
    setMessage(null);

    try {
      const response = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          maxBodySizeMb: nextBodyLimit,
          claudeLargeMessagesMode: claudeMode,
          claudeLargeMessagesThresholdKb: nextClaudeThresholdKb,
          claudeLargeMessagesTargetKb: nextClaudeTargetKb,
          claudeLargeMessagesMaxMb: nextClaudeMaxMb,
        }),
      });

      if (!response.ok) throw new Error(`Settings API returned ${response.status}`);

      const settings = (await response.json()) as SettingsResponse;
      applySettings({
        ...settings,
        maxBodySizeMb: settings.maxBodySizeMb ?? nextBodyLimit,
        claudeLargeMessagesMode: settings.claudeLargeMessagesMode ?? claudeMode,
        claudeLargeMessagesThresholdKb:
          settings.claudeLargeMessagesThresholdKb ?? nextClaudeThresholdKb,
        claudeLargeMessagesTargetKb: settings.claudeLargeMessagesTargetKb ?? nextClaudeTargetKb,
        claudeLargeMessagesMaxMb: settings.claudeLargeMessagesMaxMb ?? nextClaudeMaxMb,
      });
      setMessage({ type: "success", text: t("requestBodyLimitSaveSuccess") });
    } catch (error) {
      console.error("Failed to save request body limit:", error);
      setMessage({ type: "error", text: t("requestBodyLimitSaveFailed") });
    } finally {
      setSaving(false);
    }
  }, [
    applySettings,
    bodyLimitValue,
    claudeMaxMb,
    claudeMode,
    claudeTargetKb,
    claudeThresholdKb,
    dirty,
    t,
    validationError,
  ]);

  return (
    <Card className="p-6 mt-4">
      <div className="flex flex-col gap-6">
        <section className="flex flex-col gap-3">
          <div>
            <p className="font-medium">{t("requestBodyLimitTitle")}</p>
            <p className="text-sm text-text-muted mt-1">{t("requestBodyLimitDescription")}</p>
          </div>
          <div className="flex items-center gap-3">
            <label htmlFor="request-body-limit-mb" className="sr-only">
              {t("requestBodyLimitInputLabel")}
            </label>
            <input
              id="request-body-limit-mb"
              type="number"
              min={MIN_REQUEST_BODY_LIMIT_MB}
              max={MAX_REQUEST_BODY_LIMIT_MB}
              step={1}
              value={bodyLimitValue}
              onChange={(event) => {
                setBodyLimitValue(event.target.value);
                setMessage(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && dirty) void saveLimit();
              }}
              className="w-32 px-3 py-1.5 rounded bg-surface-2 border border-border text-sm text-text-primary"
              disabled={loading || saving}
            />
            <span className="text-xs text-text-muted">MB</span>
            {bodyLimitValue.trim() !== savedBodyLimitValue && (
              <span className="text-xs text-text-muted">
                {t("requestBodyLimitCurrent", { value: savedBodyLimitValue })}
              </span>
            )}
          </div>
          {bodyLimitValidationError && (
            <p className="text-xs text-red-500">{bodyLimitValidationError}</p>
          )}
          <p className="text-xs text-text-muted">{t("requestBodyLimitClaudeHint")}</p>
        </section>

        <section className="flex flex-col gap-3 border-t border-border pt-5">
          <div>
            <p className="font-medium">{t("claudeLargeMessagesTitle")}</p>
            <p className="text-sm text-text-muted mt-1">{t("claudeLargeMessagesDescription")}</p>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-text-muted">{t("claudeLargeMessagesThresholdLabel")}</span>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={MIN_CLAUDE_LARGE_MESSAGES_THRESHOLD_KB}
                  max={MAX_CLAUDE_LARGE_MESSAGES_THRESHOLD_KB}
                  step={1}
                  value={claudeThresholdKb}
                  onChange={(event) => {
                    setClaudeThresholdKb(event.target.value);
                    setMessage(null);
                  }}
                  className="w-28 px-3 py-1.5 rounded bg-surface-2 border border-border text-sm text-text-primary"
                  disabled={loading || saving}
                />
                <span className="text-xs text-text-muted">KB</span>
              </div>
              <span className="text-xs text-text-muted">
                {t("claudeLargeMessagesThresholdHelp")}
              </span>
            </label>
          </div>

          <div className="grid gap-3 md:grid-cols-3">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-text-muted">{t("claudeLargeMessagesModeLabel")}</span>
              <select
                value={claudeMode}
                onChange={(event) => {
                  setClaudeMode(event.target.value as ClaudeLargeMessagesMode);
                  setMessage(null);
                }}
                className="px-3 py-1.5 rounded bg-surface-2 border border-border text-sm text-text-primary"
                disabled={loading || saving}
              >
                <option value="reject">{t("claudeLargeMessagesModeReject")}</option>
                <option value="vcc">{t("claudeLargeMessagesModeVcc")}</option>
              </select>
            </label>

            <label className="flex flex-col gap-1 text-sm">
              <span className="text-text-muted">{t("claudeLargeMessagesTargetLabel")}</span>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={MIN_CLAUDE_LARGE_MESSAGES_TARGET_KB}
                  max={MAX_CLAUDE_LARGE_MESSAGES_TARGET_KB}
                  step={1}
                  value={claudeTargetKb}
                  onChange={(event) => {
                    setClaudeTargetKb(event.target.value);
                    setMessage(null);
                  }}
                  className="w-28 px-3 py-1.5 rounded bg-surface-2 border border-border text-sm text-text-primary"
                  disabled={loading || saving}
                />
                <span className="text-xs text-text-muted">KB</span>
              </div>
              <span className="text-xs text-text-muted">{t("claudeLargeMessagesTargetHelp")}</span>
            </label>

            <label className="flex flex-col gap-1 text-sm">
              <span className="text-text-muted">{t("claudeLargeMessagesMaxLabel")}</span>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={MIN_CLAUDE_LARGE_MESSAGES_MAX_MB}
                  max={MAX_CLAUDE_LARGE_MESSAGES_MAX_MB}
                  step={1}
                  value={claudeMaxMb}
                  onChange={(event) => {
                    setClaudeMaxMb(event.target.value);
                    setMessage(null);
                  }}
                  className="w-28 px-3 py-1.5 rounded bg-surface-2 border border-border text-sm text-text-primary"
                  disabled={loading || saving}
                />
                <span className="text-xs text-text-muted">MB</span>
              </div>
              <span className="text-xs text-text-muted">{t("claudeLargeMessagesMaxHelp")}</span>
            </label>
          </div>

          {claudeValidationError && <p className="text-xs text-red-500">{claudeValidationError}</p>}
        </section>

        <div className="flex items-center gap-3">
          <Button
            size="sm"
            variant="primary"
            disabled={loading || Boolean(validationError) || !dirty}
            onClick={saveLimit}
          >
            {saving ? t("requestBodyLimitSaving") : t("requestBodyLimitSave")}
          </Button>
          {dirty && (
            <span className="text-xs text-text-muted">{t("requestBodyLimitUnsavedChanges")}</span>
          )}
        </div>

        {message && (
          <p
            className={`text-xs ${
              message.type === "success"
                ? "text-green-600 dark:text-green-400"
                : "text-red-600 dark:text-red-400"
            }`}
          >
            {message.text}
          </p>
        )}
      </div>
    </Card>
  );
}
