import type { MetadataRoute } from "next";
import { PWA_THEME_COLORS } from "@/shared/constants/pwaThemeColors";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Patty",
    short_name: "Patty",
    description: "Patty — where AI becomes everyone's superpower.",
    start_url: "/dashboard",
    scope: "/",
    display: "standalone",
    orientation: "any",
    // The manifest holds one colour: the default (Editions) light background. It is fetched
    // once per install, without the visitor's palette (stored in localStorage, not a cookie), so
    // it can't follow Classic; the live viewport theme-color in layout.tsx does, per mode.
    background_color: PWA_THEME_COLORS.light,
    theme_color: PWA_THEME_COLORS.light,
    categories: ["developer-tools", "productivity", "utilities"],
    lang: "en",
    dir: "ltr",
    prefer_related_applications: false,
    icons: [
      {
        src: "/icon-192.png?v=patty-p-dot-20260830",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icon-512.png?v=patty-p-dot-20260830",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
    ],
    screenshots: [
      {
        src: "/screenshots/dashboard.png",
        sizes: "1280x720",
        type: "image/png",
        form_factor: "wide",
        label: "Dashboard",
      },
    ],
  };
}
