---
title: "Przewodnik po Progressive Web App (PWA)"
version: 3.8.51
lastUpdated: 2026-08-29
---

# Przewodnik po Progressive Web App (PWA)

Patty jest dostarczana jako w pełni instalowalna Progressive Web App dla dashboardu OmniRoute. Gdy otworzysz dashboard we wspieranej przeglądarce mobilnej — Android (Chrome) lub iOS (Safari) — możesz wybrać „Dodaj do ekranu głównego” i uzyskać doświadczenie zbliżone do natywnej aplikacji, bez sklepu z aplikacjami.

## Czym jest PWA?

Progressive Web App zamienia webowy dashboard w coś, co wygląda i działa jak natywna aplikacja mobilna. Po zainstalowaniu Patty:

- Uruchamia się z ekranu głównego z własną ikoną
- Otwiera się w samodzielnym oknie — bez paska adresu przeglądarki ani interfejsu kart
- Działa offline dzięki dedykowanej stronie łączności
- Buforuje zasoby statyczne w celu szybszego ładowania
- Obsługuje orientację pionową i poziomą

## Instalacja

Service workers wymagają bezpiecznego kontekstu przeglądarki. Dla każdego hosta innego
niż loopback użyj HTTPS; zwykły HTTP jest obsługiwany tylko lokalnie na `localhost` lub
`127.0.0.1`.

### Android (Chrome)

1. Otwórz dashboard Patty w Chrome: `https://YOUR_HOST`
2. Chrome może pokazać baner **"Add Patty to Home screen"**, albo:
   - Stuknij menu **⋮** (trzy kropki) → **"Add to Home screen"** lub **"Install app"**
3. Potwierdź monity
4. Patty pojawi się na ekranie głównym jako samodzielna aplikacja

### iOS (Safari)

1. Otwórz dashboard Patty w Safari: `https://YOUR_HOST`
2. Stuknij przycisk **Share** (kwadrat ze strzałką)
3. Przewiń w dół i stuknij **"Add to Home Screen"**
4. Nadaj nazwę (domyślnie „Patty”) i stuknij **Add**
5. Patty pojawi się na ekranie głównym z ikoną aplikacji

### Desktop (Chrome / Edge)

1. Otwórz dashboard Patty
2. Kliknij **ikona instalacji** na pasku adresu (lub ⋮ → "Install Patty...")
3. Potwierdź monity
4. Patty otworzy się jako samodzielne okno — bez kart i paska adresu

## Funkcje

### Tryb samodzielnego okna

Manifest jest skonfigurowany z `display: "standalone"`, więc zainstalowana aplikacja ma własne okno bez standardowych kart i paska adresu. System operacyjny może nadal wyświetlać własny pasek statusu i elementy nawigacji.

### Wsparcie offline

Patty zawiera service worker (`sw.js`), który zapewnia inteligentne buforowanie:

| Typ zasobu                                             | Strategia                          | Zachowanie                                                                   |
| ------------------------------------------------------ | ---------------------------------- | ---------------------------------------------------------------------------- |
| **App Shell**                                          | Cache-first                        | `/`, `/offline`, manifest i ikony są wstępnie buforowane przy instalacji     |
| **Zasoby statyczne** (CSS, JS, obrazy, fonty)          | Cache-first                        | Serwuje istniejącą odpowiedź z cache; w przeciwnym razie pobiera i buforuje  |
| **Bundle'y Next.js** (`/_next/`)                       | Network-first with cache update    | Pobiera z sieci i aktualizuje cache; offline serwuje wersję z cache          |
| **Żądania nawigacji**                                  | Network-first with cached fallback | Pobiera z sieci; wraca do żądanej strony, `/`, a następnie `/offline`        |
| **Trasy API** (`/api/`, `/a2a`, `/dashboard/endpoint`) | Bypass (never cached)              | Zawsze idzie bezpośrednio na serwer — nigdy nie jest przechwytywane przez SW |

### Strona offline

Gdy sieć jest niedostępna i użytkownik przechodzi na nową stronę, service worker serwuje dedykowaną stronę `/offline`, która:

- Wyświetla czytelny komunikat **"Connectivity Issue"**
- Pokazuje żywy **wskaźnik statusu online/offline** aktualizowany w czasie rzeczywistym
- Udostępnia przycisk **"Retry Connection"** do przeładowania po powrocie łączności
- Linkuje do **Status Page** w celach diagnostycznych

### Ikony aplikacji

Patty dostarcza ikony zoptymalizowane pod każdą platformę:

| Plik           | Rozmiar         | Używane przez                                          |
| -------------- | --------------- | ------------------------------------------------------ |
| `icon-192.png` | 192×192         | Promocję instalacji PWA w Chromium i kompaktowe ekrany |
| `icon-512.png` | 512×512         | Ekrany główne Android i iOS oraz splash screen         |
| `favicon.ico`  | Wiele rozmiarów | Karty przeglądarki i obsługę starszych przeglądarek    |

### Automatyczna rejestracja

Service worker jest rejestrowany automatycznie przez komponent `<PwaRegister />` w root layout. Nie jest potrzebna żadna akcja użytkownika — aplikacja staje się instalowalna, gdy tylko przeglądarka wykryje poprawny manifest i service worker.

## Architektura techniczna

### Web App Manifest (`manifest.webmanifest`)

Generowany przez Next.js przez `src/app/manifest.ts`:

```json
{
  "name": "Patty",
  "short_name": "Patty",
  "description": "Patty — where AI becomes everyone's superpower.",
  "start_url": "/dashboard",
  "scope": "/",
  "display": "standalone",
  "orientation": "any",
  "background_color": "#ffffff",
  "theme_color": "#ffffff",
  "icons": [
    { "src": "/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any" },
    { "src": "/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any" }
  ]
}
```

### Service Worker (`public/sw.js`)

Zwykły service worker (bez zależności frameworkowych) z:

- **Faza install**: wstępnie buforuje app shell (root, strona offline, manifest, ikony)
- **Faza activate**: czyści stare wersje cache i przejmuje wszystkie klienty
- **Faza fetch**: inteligentne routowanie według typu żądania (nawigacja, zasób statyczny, API)
- **Wersjonowanie cache**: `omniroute-pwa-v3` — zwiększ tę wartość, aby wymusić świeży cache przy aktualizacji

### Metadane layoutu (`src/app/layout.tsx`)

Root layout dostarcza wszystkie meta tagi wymagane do zgodności z PWA:

- Link `manifest` do `/manifest.webmanifest`
- `apple-web-app-capable: true` dla trybu standalone na iOS
- `apple-web-app-status-bar-style: black-translucent`
- `mobile-web-app-capable: yes` dla Chrome na Androidzie
- `theme-color: #0b0f1a`
- `viewport-fit: cover` do renderowania od krawędzi do krawędzi

### Komponent: `PwaRegister`

Znajduje się w `src/shared/components/PwaRegister.tsx`. Ten komponent kliencki:

1. Uruchamia się przy montowaniu (tylko po stronie klienta)
2. Sprawdza obsługę `serviceWorker` w przeglądarce
3. Rejestruje `/sw.js` w tle (błędy są połykane, aby nie blokować aplikacji)
4. Nic nie renderuje (`return null`) — to komponent wyłącznie ze skutkami ubocznymi

## Użycie z Termux (Android)

Przy uruchamianiu OmniRoute na Androidzie przez Termux PWA działa bezproblemowo:

1. Uruchom OmniRoute w Termux: `npx omniroute`
2. Otwórz Chrome na tym samym telefonie: `http://localhost:20128`
3. Zainstaluj Patty przez "Add to Home Screen"
4. Patty łączy się z lokalnym serwerem Termux — wszystko działa na urządzeniu

Ta kombinacja oznacza, że telefon z Androidem jest jednocześnie **serwerem** (Termux) i **klientem** (PWA) — kompletna, samodzielna brama AI.

## Użycie z innych urządzeń

Zainstaluj Patty na dowolnym urządzeniu, które ma bezpieczny dostęp przeglądarkowy do
serwera OmniRoute:

- **Inny telefon/tablet**: przejdź pod adres HTTPS serwera i zainstaluj PWA
- **Laptop**: otwórz Chrome/Edge i zainstaluj jako desktopowe PWA
- **Smart TV z przeglądarką**: otwórz dashboard w samodzielnym oknie, jeśli jest wspierane

## Dostosowywanie

### Nazwa instancji

Tytuł przeglądarki i metadane aplikacji respektują ustawienie **Instance Name** z `Dashboard → Settings`. Nazwa w manifeście instalacyjnym pozostaje ustawiona na **Patty**.

### Własny favicon

Jeśli wgrasz własny favicon przez `Dashboard → Settings`, karty przeglądarki użyją
własnej ikony. Zainstalowane PWA używa wbudowanych plików `icon-192.png` i
`icon-512.png`.

## Ograniczenia

- **Push notifications zależne od platformy** — service worker obsługuje zdarzenia push, ale dostarczanie i działanie w tle zależą od wsparcia przeglądarki, zasad systemu operacyjnego i uprawnienia do powiadomień.
- **Brak background sync** — akcje offline nie są kolejkowane do ponownego odtworzenia. PWA jest przede wszystkim przeglądarką dashboardu.
- **Ograniczenia iOS** — Safari na iOS nie obsługuje wszystkich funkcji PWA (np. monity instalacji są ręczne, a background service workers są ograniczone).
- **Rozmiar cache** — service worker buforuje wyłącznie zasoby statyczne. Duże payloady odpowiedzi z tras `/api/` nigdy nie trafiają do cache.
- **Własne ikony na mobile** — zmiana faviconu w ustawieniach nie aktualizuje ikony ekranu głównego na mobile (wymaga to regeneracji ikon PWA).

## Referencja plików

| Plik                                    | Przeznaczenie                                                  |
| --------------------------------------- | -------------------------------------------------------------- |
| `src/app/manifest.ts`                   | Trasa manifestu Next.js (generuje `manifest.webmanifest`)      |
| `public/sw.js`                          | Service worker z logiką cache                                  |
| `src/shared/components/PwaRegister.tsx` | Komponent kliencki rejestrujący service worker                 |
| `src/app/offline/page.tsx`              | Strona fallback offline z żywym wskaźnikiem statusu            |
| `src/app/layout.tsx`                    | Root layout z metadanymi PWA (apple-web-app, theme-color itd.) |
| `public/icon-192.png`                   | Ikona PNG 192×192 (promocja instalacji w Chromium)             |
| `public/icon-512.png`                   | Ikona PNG 512×512 (Android, iOS, splash screen)                |
| `public/favicon.ico`                    | Favicon przeglądarki w wielu rozmiarach                        |
