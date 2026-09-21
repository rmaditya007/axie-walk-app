# Axie GO — real GPS walk/run tracker

A real web app (not a Claude artifact): a live real-world map with your Axie moving on it from real device GPS, a splash screen, an activity history tab with charts, a leaderboard tab, and Strava-style share cards — with an actual real map snapshot of your route baked in, since this app runs in a normal browser tab and isn't sandboxed the way the Claude artifact is.

## Why this isn't a Claude artifact

Two things this needs can't run inside the sandboxed Claude artifact preview:
- **A live map** has to fetch map-tile images from an external server every time you pan or zoom. The artifact sandbox only allows loading a few CDNs' *scripts* — no image/tile fetches from anywhere else — so a real map (Google Maps or free OpenStreetMap/Leaflet alike) is a hard no there. That's also why the artifact build (`axie-go.html`, the "Axie GO" Claude link) shows your Axie on a stylized 3D field instead of a real map.
- **Real GPS** needs a normal top-level browser tab with a real permission prompt. That's unreliable inside the embedded preview.

So this is a real project you run and open in a real browser, same as the earlier Three.js prototype.

**The trade-off**: because this app has no backend server of its own, the "Leaderboard" tab here is shaped like a real multiplayer leaderboard (Daily/Weekly/Monthly, Walk/Run tabs, ranked rows) but only ever shows your own device's activities — there's no shared server for other players' sessions to land on. The Claude artifact link has a real shared leaderboard (via a Claude-only shared-data feature this standalone app can't reach), but trades away the real map for it. Right now you get one or the other, not both, unless a real backend gets added here later.

## Run it today (on your phone, over Wi-Fi)

```sh
npm install
npm run dev
```

Vite prints two URLs — use the **Network** one (`https://<your-computer's-LAN-IP>:5173/`) on your phone's browser, as long as your phone and computer are on the same Wi-Fi. It's HTTPS with a self-signed certificate (see "Why HTTPS?" below), so your phone will show a "connection not private" style warning the first time — tap **Advanced → Proceed** (Chrome/Android) or **Show Details → visit this website** (Safari/iOS). After that one click-through, grant location access when it asks. Walk around outside — the map, distance, and $bAXS should update live, with your Axie moving on real streets and a glowing orange trail behind it.

### Why HTTPS?

Two things this app needs — the native share sheet, and (on iOS specifically) GPS itself — refuse to run at all on a plain `http://` address on a phone; browsers only allow them in a "secure context" (HTTPS, or `localhost`). `npm run dev` now serves over HTTPS automatically (via `@vitejs/plugin-basic-ssl`, a dev-only self-signed certificate) specifically so both work when you test on your phone. The one-time browser warning is expected and safe to click through — it's just your own dev server, not a real security risk.

```sh
npm run build     # production build to dist/
npm run preview   # serve the production build locally
```

## What's implemented

- **Splash screen**: "AXIE GO" branded intro, matching the Claude-artifact build, with a welcome-back recap if you've logged activities before.
- **Real map**: Leaflet + OpenStreetMap's free raster tiles — no API key, no billing. (We started on CARTO's free dark basemap, but CARTO now requires a registered API key for even the free tier — you'd have hit a watermarked "API KEY REQUIRED" tile if you tested before this update. OSM's tiles are light-only, so we fake the dark theme with a CSS filter — `invert(1) hue-rotate(180deg) brightness(0.92) contrast(0.92) saturate(0.9)` — applied to the tile layer.)
- **Real 3D Axie on the map**: your chosen Axie (see "Choose your Axie" below) floats over your live GPS position in a small transparent WebGL canvas synced to the map's pan/zoom, with an orange trail behind it showing where you've walked. It plays its Idle/Walk/Run animations depending on your session state and mode, and turns to visually face the direction you're actually moving, computed from consecutive GPS fixes (`src/axie3d.js`). Leaflet itself has no concept of a 3D layer — this is a plain floating DOM canvas kept in sync with the map, not a Leaflet marker — so if WebGL isn't available on a device, it falls back to a flat circular portrait marker instead of a blank spot.
- **Choose your Axie**: tap the round portrait button, top-left of the Track view, to search and pick from 7 animated Axies (`src/axieCatalog.js`, `src/axiePicker`-style logic in `main.js`) — each tap on a search result spins it up live in 3D (`src/axiePreview.js`) before you confirm. Your pick is remembered and used everywhere: the map overlay, the 3D World view, and the flat-marker fallback.
- **3D World mode**: tap "3D World" (top-right of the Track view) to swap the real map for a stylized 3D field your Axie walks/runs through instead (`src/axieWorld.js`) — same GPS session underneath, same real distance/steps/$bAXS, just a different visualization for when you'd rather not look at a real street map. It's a from-scratch procedural field (ground, sky, trees, rocks), not borrowed 3D scenery — see the note at the top of `axieWorld.js` for why: the Axie Origins Asset Kit repo named in the original ask turned out to be 2D battle-VFX/Spine assets for a Unity game, not an exportable 3D scene, so there was nothing "world"-shaped there to pull in. The characters themselves *are* real assets from `jaatster/axie-3d-assets`, used under that pack's Axie Vibeathon usage permission — see `RIGHTS.md` in that repo.
- **Real GPS**: `navigator.geolocation.watchPosition`, filtered against GPS noise (readings worse than 35m accuracy, or implausible speed jumps, are ignored for distance but still move the marker).
- **Walk / Run toggle**: tags the session type. (Real GPS gives us real speed directly, so unlike a simulated demo, nothing here needs to *fake* your pace.)
- **The rule**: 1000 steps = 0.1 $bAXS. Steps are *estimated* from GPS distance (`distance_m / 0.78`) since a browser has no pedometer — that's a real limitation, not hidden.
- **GO / Pause / Resume / Stop**: GO starts tracking. Pause freezes the session without discarding it (Resume picks back up, Stop ends and saves). Saving banks the session into your history and your running totals (kept in this browser's local storage), then offers to share it.
- **Activity tab**: overall totals, a day streak counter, a last-7-days km bar chart, a walk-vs-run split ring, a cumulative $bAXS-over-time chart, and the full history list filterable by Walk/Run — each row has a share icon.
- **Leaderboard tab**: Walk/Run tabs over Daily/Weekly/Monthly ranked rows. See the trade-off note above for why it's only ever "You" in first place right now.
- **Background step counter**: tap the round toggle on the Activity tab's "Background steps" card to turn on all-day step counting — it keeps running with the app closed, backed by a real Android foreground service reading the phone's own hardware step-counter sensor (`android/.../StepCounterService.kt`), with a permanent, always-updating notification (this is a real native notification, not a web page trick — something a Claude artifact genuinely cannot do). It needs the "Physical activity" and notification permissions, which the toggle requests for you. **This is deliberately separate from $bAXS**: background steps show in the notification and the Activity tab, but only an explicit GO session still earns $bAXS — see "Background steps vs $bAXS" below for why. Optionally, tap "Sync" next to Health Connect (if it's installed — built into Android 14+, a free Play Store app on older versions) to also write your steps there and see the combined total from every app that syncs to it; Google Fit's own APIs are being retired through 2026 in favor of Health Connect, so that's the integration built here rather than the old Fit SDK.
- **Challenge tab**: three fixed 24-hour pools — Beginner (free, 100 $bAXS reward, top 25), Pro (5 $bAXS entry, 1000 $bAXS reward), Expert (20 $bAXS entry, 1000 $bAXS reward). Entering deducts the entry fee from your $bAXS total; logging any walk or run before the 24-hour window closes pays out the reward when it settles (checked once a second while the tab is open, and once on app launch in case the window passed while it was closed). Same honesty as the Leaderboard: with no shared backend, you're the only real entrant, so this is really "log something before the clock runs out," not real competition — a live pool needs a server behind it.
- **Share cards**: tapping the share icon (or finishing a session) renders a Strava-style card — a real snapshot of your actual route on the real map (captured via `html2canvas`, with a plain-drawn fallback if that capture ever fails), plus distance/time/pace/$bAXS underneath. "Share" uses the real Web Share API when your browser supports it (an actual OS share sheet — Instagram, Messages, AirDrop, whatever you have), falling back to a plain image download otherwise.
- **No real tokens, ever**: $bAXS here is a simulated running number the app keeps for itself. Nothing in this app touches a wallet, mints anything, or moves real funds — that's a hard line regardless of what the UI shows.
- **No GPS fallback**: if location is denied or unavailable, the app clearly labels itself "Simulated route" and moves your Axie around a small demo loop instead of pretending to have real data.

## Background steps vs $bAXS

The background step counter and the $bAXS economy are intentionally kept apart. The
counter's job is just to answer "how many steps today" honestly and continuously,
the way any pedometer app does — it doesn't know or care whether you're playing
Axie GO at that moment. $bAXS is earned only by pressing GO, which starts a real
GPS-tracked session; that stays true whether or not background tracking is on.
Merging the two — auto-paying $bAXS for background steps — would mean the app
pays out for a phone bouncing around in a bag, so it's left as a separate, honest
display instead. If you want that changed later (e.g. a smaller passive trickle of
$bAXS for background steps, on top of the session-based earning), that's a real
product decision to make explicitly, not a technical limitation.

### Testing it

1. Install the rebuilt APK (this rebuild bumped `minSdkVersion` to 26 — Android
   8.0+ — because Health Connect's own library requires it; this drops support for
   the very few remaining Android 7.x devices).
2. Open the Activity tab and tap "Turn on" on the Background steps card. Grant
   the physical-activity permission when asked (and the notification permission,
   on Android 13+).
3. Pull down your notification shade — you should see an ongoing "N steps today"
   notification that can't be swiped away, and updates as you walk.
4. Lock the phone, or close the app entirely (swipe it away from recents), and
   keep walking — the notification should keep updating. This is the actual
   feature: it does not depend on Axie GO being open.
5. Optional: tap "Sync" next to Health Connect once it's installed and see the
   combined total from every Health-Connect-linked app.

### Known limitations, honestly

- **OEM battery optimization can still kill it.** Stock Android respects a
  foreground service with an ongoing notification, but several manufacturers
  (Xiaomi/MIUI, Samsung, Huawei, OnePlus/Oppo/Realme, and others) layer their own,
  much more aggressive battery managers on top that can kill background services
  anyway, foreground or not. If steps stop updating after a while, go to your
  phone's Settings → Battery → find Axie GO → turn off battery optimization /
  set to "unrestricted" / disable "auto-launch" management (the exact wording and
  location vary a lot by manufacturer and Android version).
- **The step count is the phone's own hardware sensor**, not GPS — it works with
  the phone in a pocket, doesn't need location permission, and won't perfectly
  match a wrist-worn tracker's count (different accelerometer placement).
- **Health Connect sync is one-way by default** (Axie GO → Health Connect) plus a
  read of the combined total for display; it does not pull other apps' steps into
  your in-app "Total $bAXS" or activity history.
- **I could not compile or test any of this myself** — this sandbox has no Android
  emulator and no real phone, and (same as the Gradle-download limitation above)
  no path to Maven Central for the new dependencies this feature needed
  (`androidx.health.connect:connect-client`, the Kotlin Gradle plugin,
  `kotlinx-coroutines-android`). It's written carefully against the official
  Android and Capacitor plugin documentation, but the real compile happens on
  your machine via Android Studio (same as the last build) — if it errors, send
  me the exact error text and I'll fix it.

## Switching to Google Maps

Right now the map uses OpenStreetMap's free tiles (`src/main.js`, the `L.tileLayer(...)` call) — zero setup, no key. If you'd rather use real Google Maps, you'll need your own Google Cloud project with the Maps JavaScript API enabled and billing turned on (Google requires this; there's no free-tier key I can generate for you). Once you have a key, swap the Leaflet tile layer for the Google Maps JS API — it's a different library (not a drop-in tile URL), so that's a small rewrite of the map-init code in `src/main.js`, not a config flag. Note the share-card capture relies on the tile layer's `crossOrigin: true` option working against whatever tile host you use — Google's tiles are loaded through their JS SDK's own canvas, not plain `<img>` tags, so swapping to Google Maps would need the share-card capture logic revisited too. The floating 3D Axie overlay (`src/axie3d.js`) is independent of whichever tile provider you use — it's positioned from the map's own pixel-projection API, not tied to CARTO/OSM/Google specifically.

## 3D asset credits

The 7 selectable Axies (Bing, Kibo, Kotaro, Paladill, Pomodoro, Tripp, Xia — `public/axies/*.glb`, ~19 MB total) are Sky Mavis-owned models from [jaatster/axie-3d-assets](https://github.com/jaatster/axie-3d-assets), a GLB pack explicitly approved for Axie Vibeathon and Sky Mavis-approved Axie projects. Read that repo's `RIGHTS.md` before reusing them anywhere outside this kind of project — it's a limited-use permission, not a general-purpose asset pack, and doesn't allow redistributing the files standalone.

## Installable Android APK

The Capacitor Android wrapper is already set up in this project (`android/`, `capacitor.config.ts`) — app id `com.lumel.axiego`, name "Axie GO", with `ACCESS_FINE_LOCATION` / `ACCESS_COARSE_LOCATION` / `INTERNET` already declared in `android/app/src/main/AndroidManifest.xml` so the GPS permission prompt works inside the wrapped app. **I could not build the actual `.apk` file myself** — I set up everything that doesn't need network access (the whole `android/` project scaffold, from Capacitor's own npm package, no download required), but the next step genuinely needs internet I don't have here: I checked directly and this sandbox's network policy blocks `dl.google.com`, `maven.google.com`, and Maven Central (`repo.maven.apache.org`) — exactly the servers Gradle needs to fetch the Android Gradle Plugin and its dependencies. Your own machine has normal internet access, so this last step is genuinely just one command for you:

```sh
npm run android:build
```

(That's `vite build` + `npx cap sync android` + `cd android && ./gradlew assembleDebug` chained together.) The first run will take a few minutes — Gradle downloads itself and the Android build tools the first time. When it finishes, the APK is at:

```
android/app/build/outputs/apk/debug/app-debug.apk
```

Copy that to your phone and open it (enable "Install unknown apps" for your file manager/browser once) to install it directly — no Play Store, no signing needed for a debug build.

Prefer a GUI: open the `android/` folder in [Android Studio](https://developer.android.com/studio) and hit Run — same result, and it'll offer to install straight onto a connected phone or emulator.

**Whenever you change the web app** (anything in `src/` or `index.html`), re-run `npm run android:sync` before rebuilding the APK — Capacitor copies the built web assets into the Android project, it doesn't watch them live.
