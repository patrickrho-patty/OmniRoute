"use client";

import { useTranslations } from "next-intl";
import { useState, useEffect } from "react";
import { useIsElectron } from "@/shared/hooks/useElectron";

/**
 * Forgot Password Page — Phase 8.2
 *
 * Provides recovery methods:
 * - Web/CLI: manual database reset
 * - Electron: Data directory reset instructions
 */

import Link from "next/link";
import { Card } from "@/shared/components";

export default function ForgotPasswordPage() {
  const t = useTranslations("auth");
  const isElectron = useIsElectron();
  const [dataDir, setDataDir] = useState<string | null>(null);

  useEffect(() => {
    if (isElectron && typeof window !== "undefined" && (window as any).electronAPI?.getDataDir) {
      (window as any).electronAPI
        .getDataDir()
        .then((dir: string) => setDataDir(dir))
        .catch(() => {});
    }
  }, [isElectron]);

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-white text-[#0a0a0b]">
      <div className="w-full max-w-lg">
        <div className="flex items-center justify-center mb-6">
          <span className="text-xl font-semibold tracking-tight text-[#0a0a0b]">Patty</span>
        </div>

        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-[#0a0a0b] mb-2">{t("resetPassword")}</h1>
          <p className="text-black/60">{t("resetDescription")}</p>
        </div>

        {isElectron ? (
          <>
            {/* Electron: App Reset Method */}
            <Card className="mb-4 border border-black/10 rounded-xl">
              <div className="flex items-start gap-4 p-2">
                <div className="flex items-center justify-center size-10 rounded-lg bg-black/5 text-[#0a0a0b] shrink-0 mt-0.5">
                  <span className="material-symbols-outlined text-[20px]" aria-hidden="true">
                    folder_open
                  </span>
                </div>
                <div className="flex-1">
                  <h2 className="text-lg font-semibold mb-1 text-[#0a0a0b]">Reset via App Data</h2>
                  <p className="text-sm text-black/60 mb-3">
                    Delete the settings file from the app data directory to reset your password:
                  </p>
                  <ol className="text-sm text-black/60 space-y-2 list-decimal list-inside mb-3">
                    <li>Quit the application completely</li>
                    <li>
                      Navigate to the app data directory:
                      {dataDir ? (
                        <div className="bg-white border border-black/10 rounded-lg p-2 mt-1 font-mono text-xs text-[#0a0a0b] break-all">
                          {dataDir}
                        </div>
                      ) : (
                        <div className="bg-white border border-black/10 rounded-lg p-2 mt-1 font-mono text-xs text-[#0a0a0b]">
                          <span className="text-black/60">(Check your system app data folder)</span>
                        </div>
                      )}
                    </li>
                    <li>
                      Delete{" "}
                      <code className="bg-black/5 px-1 rounded text-[#0a0a0b]">settings.json</code>{" "}
                      ({t("orRemovePasswordHashField")})
                    </li>
                    <li>Relaunch the application — it will start fresh setup</li>
                  </ol>
                </div>
              </div>
            </Card>

            {/* Electron: Env File Method */}
            <Card className="mb-6 border border-black/10 rounded-xl">
              <div className="flex items-start gap-4 p-2">
                <div className="flex items-center justify-center size-10 rounded-lg bg-black/5 text-[#0a0a0b] shrink-0 mt-0.5">
                  <span className="material-symbols-outlined text-[20px]" aria-hidden="true">
                    settings
                  </span>
                </div>
                <div className="flex-1">
                  <h2 className="text-lg font-semibold mb-1 text-[#0a0a0b]">
                    Alternative: Set New Password
                  </h2>
                  <p className="text-sm text-black/60 mb-3">
                    Set a new initial password via the server environment file:
                  </p>
                  <ol className="text-sm text-black/60 space-y-2 list-decimal list-inside mb-3">
                    <li>Quit the application completely</li>
                    <li>
                      Open{" "}
                      <code className="bg-black/5 px-1 rounded text-[#0a0a0b]">server.env</code> in
                      the data directory
                      {dataDir && (
                        <div className="bg-white border border-black/10 rounded-lg p-2 mt-1 font-mono text-xs text-[#0a0a0b] break-all">
                          {dataDir}/server.env
                        </div>
                      )}
                    </li>
                    <li>
                      Add or update:
                      <div className="bg-white border border-black/10 rounded-lg p-2 mt-1 font-mono text-xs text-[#0a0a0b]">
                        INITIAL_PASSWORD={t("newPasswordPlaceholder")}
                      </div>
                    </li>
                    <li>
                      Delete{" "}
                      <code className="bg-black/5 px-1 rounded text-[#0a0a0b]">settings.json</code>{" "}
                      from the data directory
                    </li>
                    <li>Relaunch the application</li>
                  </ol>
                </div>
              </div>
            </Card>
          </>
        ) : (
          <>
            <p className="text-sm text-black/60 text-center mb-6">
              If you&rsquo;ve lost your password, contact your administrator or reset it locally:
            </p>

            {/* Database Reset */}
            <Card className="mb-6 border border-black/10 rounded-xl">
              <div className="flex items-start gap-4 p-2">
                <div className="flex items-center justify-center size-10 rounded-lg bg-black/5 text-[#0a0a0b] shrink-0 mt-0.5">
                  <span className="material-symbols-outlined text-[20px]" aria-hidden="true">
                    database
                  </span>
                </div>
                <div className="flex-1">
                  <h2 className="text-lg font-semibold mb-1 text-[#0a0a0b]">
                    {t("methodManualTitle")}
                  </h2>
                  <p className="text-sm text-black/60 mb-3">{t("methodManualDescription")}</p>
                  <ol className="text-sm text-black/60 space-y-2 list-decimal list-inside mb-3">
                    <li>{t("stopServer")}</li>
                    <li>
                      {t("setPasswordInYour")}{" "}
                      <code className="bg-black/5 px-1 rounded text-[#0a0a0b]">.env</code>{" "}
                      {t("fileLabelSuffix")}
                      <div className="bg-white border border-black/10 rounded-lg p-2 mt-1 font-mono text-xs text-[#0a0a0b]">
                        INITIAL_PASSWORD={t("newPasswordPlaceholder")}
                      </div>
                    </li>
                    <li>
                      {t("deleteSettingsFile")}{" "}
                      <code className="bg-black/5 px-1 rounded text-[#0a0a0b]">
                        data/settings.json
                      </code>{" "}
                      ({t("orRemovePasswordHashField")})
                    </li>
                    <li>{t("restartServerWithNewPassword")}</li>
                  </ol>
                </div>
              </div>
            </Card>
          </>
        )}

        <div className="text-center">
          <Link
            href="/login"
            className="text-sm text-[#0a0a0b] hover:underline inline-flex items-center gap-1"
          >
            <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
              arrow_back
            </span>
            {t("backToLogin")}
          </Link>
        </div>
      </div>
    </div>
  );
}
