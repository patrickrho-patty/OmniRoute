/**
 * Layout shell for the Patty-branded public auth surface (login).
 *
 * Forces a light, monochrome Patty palette regardless of the app ThemeProvider's
 * dark default — the authed dashboard keeps its theming, but the public login
 * must render identically for every visitor and match patty.io's light identity.
 * Palette tokens are centralized here so the four login render branches stay
 * in sync. Pretendard is self-hosted via globals.css (no CDN dependency).
 */
import type { ReactNode } from "react";

type PattyShellProps = {
  children: ReactNode;
  /** Optional top banner (e.g. node-incompatible warning). */
  banner?: ReactNode;
};

export default function PattyShell({ children, banner }: PattyShellProps) {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-6 bg-white font-['Pretendard_Variable',_Pretendard,-apple-system,system-ui,sans-serif] tracking-[-0.03em] text-[#0a0a0b]">
      {banner}
      {children}
    </div>
  );
}
