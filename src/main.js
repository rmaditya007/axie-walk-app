import './style.css';
import L from 'leaflet';
import html2canvas from 'html2canvas';
import { createAxieOverlay } from './axie3d.js';
import { createAxieWorld } from './axieWorld.js';
import { createCharacterPreview } from './axiePreview.js';
import { AXIES, getAxie, portraitPath, DEFAULT_AXIE_ID } from './axieCatalog.js';
import { StepCounter, isNative } from './stepCounter.js';
import { LocationTracking } from './locationTracking.js';

/* =============================================================================
   Axie GO — real GPS walk/run tracker

   This is a real standalone web app (not a Claude artifact) because a live
   map needs to fetch map-tile images from an external server on every pan and
   zoom, and real GPS needs a normal top-level browser tab with a real
   permission prompt — neither works inside the sandboxed Claude artifact
   preview (its CSP only allows a few CDNs' *scripts*, no image/tile fetches
   from anywhere else). Run it with `npm run dev` and open it on your phone —
   see README.md for exact steps.

   Because this runs as a plain page in your own browser, it also gets things
   the artifact can't offer: a real map with real tile imagery, and — on the
   share card — a real native share sheet via the Web Share API, not just a
   "save image" button.

   Rule: 1000 steps = 0.1 $bAXS. Steps are ESTIMATED from GPS distance
   (distance_m / 0.78m average stride) since a browser has no pedometer —
   that's disclosed in the UI, not hidden. $bAXS shown here is a simulated
   running total only: this app never touches a wallet or moves real tokens.

   The "Leaderboard" tab only ever shows YOUR OWN device's activities (day/
   week/month, Walk or Run) — it is NOT a real multiplayer leaderboard yet.
   A real one needs a backend other players' devices can write to, which
   this standalone app doesn't have. The UI is shaped like a real
   leaderboard (ranked rows, period + type tabs) so wiring one in later is
   just a data-source swap, not a redesign.
   ============================================================================= */

const STRIDE_M = 0.78;
const BAXS_PER_STEP = 0.1 / 1000;
const MIN_ACCURACY_M = 35;
const MAX_PLAUSIBLE_SPEED_MPS = 8; // ~28.8 km/h — beyond this, treat as a GPS jump and discard
const SIM_CENTER = { lat: 13.0500, lng: 80.2824 }; // demo center used only if location is denied/unavailable
const SIM_SPEED_MPS = { walk: 1.35, run: 2.7 };
const MAX_ROUTE_POINTS = 300; // downsample stored per-activity route to keep localStorage small

const STORAGE_KEY = 'axie-go-walk-v2';
const OLD_STORAGE_KEY = 'petal-trail-walk-v1'; // v1 totals-only shape, migrated in on first load

/* ---------------------------------------------------------------------
   State + persistence
   --------------------------------------------------------------------- */
let state = {
  totalKm: 0,
  totalBaxs: 0,
  totalSteps: 0,
  activities: [],
  selectedAxie: DEFAULT_AXIE_ID,
  challenges: { active: {}, history: [] }, // active: { [poolId]: {poolId, enteredAt, endsAt, distanceKm} } — one entry per pool you've joined, so joining Pro doesn't block Beginner or Expert
};

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) { state = { ...state, ...JSON.parse(raw) }; return; }
  } catch (e) { /* ignore */ }
  try {
    const oldRaw = localStorage.getItem(OLD_STORAGE_KEY);
    if (oldRaw) {
      const old = JSON.parse(oldRaw);
      state.totalKm = old.totalKm || 0;
      state.totalBaxs = old.totalBaxs || 0;
      state.totalSteps = old.totalSteps || 0;
    }
  } catch (e) { /* ignore */ }
}
loadState();

// Migrate older saves: state.challenges.active used to be a single object
// (or null) since only one pool could be joined at a time. Now it's a map
// keyed by poolId so multiple pools can run concurrently.
(function normalizeChallengesState() {
  const active = state.challenges && state.challenges.active;
  if (!active) { state.challenges.active = {}; return; }
  if (active.poolId) { state.challenges.active = { [active.poolId]: active }; }
})();

function persistState() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
}

function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function fmtTime(sec) {
  const m = Math.floor(sec / 60).toString().padStart(2, '0');
  const s = Math.floor(sec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}
function dateKey(ts) { const d = new Date(ts); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; }
function dayLabel(ts) {
  const d = new Date(ts), now = new Date();
  const isToday = dateKey(ts) === dateKey(now.getTime());
  const yest = new Date(now); yest.setDate(yest.getDate() - 1);
  const isYesterday = dateKey(ts) === dateKey(yest.getTime());
  if (isToday) return 'Today';
  if (isYesterday) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}
function timeLabel(ts) { return new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }); }

function haversineMeters(a, b) {
  const R = 6371000;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const la1 = a.lat * Math.PI / 180;
  const la2 = b.lat * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function downsample(points, maxLen) {
  if (points.length <= maxLen) return points;
  const step = points.length / maxLen;
  const out = [];
  for (let i = 0; i < maxLen; i++) out.push(points[Math.floor(i * step)]);
  out.push(points[points.length - 1]);
  return out;
}

function computeTotals(activities) {
  return activities.reduce((acc, a) => {
    acc.km += a.distanceKm || 0;
    acc.baxs += a.baxs || 0;
    acc.steps += a.steps || 0;
    acc.count += 1;
    return acc;
  }, { km: 0, baxs: 0, steps: 0, count: 0 });
}

function computeStreak(activities) {
  if (!activities.length) return 0;
  const days = new Set(activities.map((a) => dateKey(a.endedAt || a.startedAt)));
  let streak = 0;
  const cursor = new Date();
  for (;;) {
    const key = dateKey(cursor.getTime());
    if (days.has(key)) { streak++; cursor.setDate(cursor.getDate() - 1); }
    else if (streak === 0 && key === dateKey(Date.now())) { cursor.setDate(cursor.getDate() - 1); continue; }
    else break;
  }
  return streak;
}

function emptyBucket() { return { km: 0, baxs: 0, steps: 0, walk: { km: 0, baxs: 0, steps: 0 }, run: { km: 0, baxs: 0, steps: 0 } }; }

function computeDailyBuckets(activities, maxDays) {
  const cutoff = Date.now() - maxDays * 86400000;
  const buckets = {};
  for (const a of activities) {
    const ts = a.endedAt || a.startedAt;
    if (ts < cutoff) continue;
    const key = dateKey(ts);
    if (!buckets[key]) buckets[key] = emptyBucket();
    const b = buckets[key];
    const t = a.type === 'run' ? 'run' : 'walk';
    b.km += a.distanceKm || 0; b.baxs += a.baxs || 0; b.steps += a.steps || 0;
    b[t].km += a.distanceKm || 0; b[t].baxs += a.baxs || 0; b[t].steps += a.steps || 0;
  }
  return buckets;
}

function periodStartMs(period) {
  const now = new Date();
  if (period === 'day') { const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime(); }
  if (period === 'week') { const d = new Date(now); const dow = (d.getDay() + 6) % 7; d.setDate(d.getDate() - dow); d.setHours(0, 0, 0, 0); return d.getTime(); }
  if (period === 'month') { const d = new Date(now.getFullYear(), now.getMonth(), 1); return d.getTime(); }
  return 0; // all-time
}

function paceLabel(a) {
  if (!a.distanceKm || a.distanceKm <= 0) return '—';
  const secPerKm = a.durationSec / a.distanceKm;
  if (!isFinite(secPerKm) || secPerKm <= 0) return '—';
  const m = Math.floor(secPerKm / 60), s = Math.round(secPerKm % 60);
  return `${m}:${String(s).padStart(2, '0')}/km`;
}

/* ---------------------------------------------------------------------
   Map setup
   --------------------------------------------------------------------- */
const map = L.map('map', {
  zoomControl: false,
  // No attribution control shown in the UI (removed per request) — note
  // OpenStreetMap's tile usage policy technically expects attribution on
  // any public-facing app using their tiles; worth adding back if this
  // ships beyond personal testing.
  attributionControl: false,
  center: [SIM_CENTER.lat, SIM_CENTER.lng],
  zoom: 17,
});

// Plain OpenStreetMap raster tiles — free, no API key. (CARTO's free basemap
// tiles, used here previously, now require a registered key — their tiles
// started coming back as "API KEY REQUIRED" placeholder images. OSM's are
// a light basemap by default; .tile-dark-filter below fakes the app's dark
// look with a CSS filter rather than needing a real dark tile provider.)
// crossOrigin is required so the share-card capture below (html2canvas) can
// read tile pixels without the canvas being "tainted" by a cross-origin
// image — OSM's tiles serve CORS headers exactly so this kind of
// client-side export works. Swap this tile layer for the Google Maps JS
// API if/when you have a billing-enabled key — see README.md "Switching to
// Google Maps".
const tileLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  subdomains: 'abc',
  maxZoom: 19,
  crossOrigin: true,
  className: 'tile-dark-filter',
}).addTo(map);

// The route trail — a real Leaflet SVG path, given a CSS drop-shadow glow
// (see .trail-glow in style.css) via the `className` option. Kept as one
// path (not the map's default renderer swapped to Canvas) specifically so
// that className/CSS filter trick works — Leaflet's Canvas renderer draws
// every layer into one shared <canvas> with no per-layer DOM node to style.
const trail = L.polyline([], {
  color: '#ff9d2e',
  weight: 5,
  opacity: 1,
  lineCap: 'round',
  lineJoin: 'round',
  className: 'trail-glow',
}).addTo(map);

// A live 3D Kotaro floats over the map at the player's position — the
// real-map equivalent of the artifact build's stylized-3D-field view. It's
// a plain positioned canvas synced to the map on every pan/zoom, not a
// Leaflet marker, since Leaflet has no notion of a 3D layer.
let currentLatLng = L.latLng(SIM_CENTER.lat, SIM_CENTER.lng);
const axie3dWrap = document.getElementById('axie3d-wrap');
const axie3dCanvas = document.getElementById('axie3d-canvas');
let axie3d = null;
let overlayFallback = false; // true once the 3D overlay has given up and shown a flat marker instead
const OVERLAY_SIZE = 96;

// Which Axie is currently loaded (map overlay + 3D World + share/branding
// wherever it matters) — a user choice made in the picker sheet (see the
// "Axie picker" section below), persisted across sessions.
let currentAxieId = getAxie(state.selectedAxie).id;
const axieAvatarImg = document.getElementById('axie-avatar-img');
axieAvatarImg.src = portraitPath(currentAxieId);

function positionOverlay() {
  const pt = map.latLngToContainerPoint(currentLatLng);
  axie3dWrap.style.transform = `translate(${pt.x - OVERLAY_SIZE / 2}px, ${pt.y - OVERLAY_SIZE * 0.78}px)`;
}
map.on('move zoom viewreset', positionOverlay);

createAxieOverlay(axie3dCanvas, OVERLAY_SIZE, currentAxieId)
  .then((overlay) => {
    axie3d = overlay;
    positionOverlay();
  })
  .catch((e) => {
    console.warn('3D Axie overlay failed to load, falling back to a flat marker', e);
    overlayFallback = true;
    axie3dWrap.hidden = true;
    const fallbackIcon = L.divIcon({
      className: 'axie-marker-fallback',
      html: '',
      iconSize: [46, 46],
      iconAnchor: [23, 40],
    });
    const fallbackMarker = L.marker(currentLatLng, { icon: fallbackIcon }).addTo(map);
    fallbackMarker.getElement().style.backgroundImage = `url('${portraitPath(currentAxieId)}')`;
    axie3d = { playAction() {}, setHeading() {}, setCharacter() {}, _fallbackMarker: fallbackMarker };
  });

function updateAxiePosition(lat, lng) {
  currentLatLng = L.latLng(lat, lng);
  if (axie3d && axie3d._fallbackMarker) axie3d._fallbackMarker.setLatLng(currentLatLng);
  positionOverlay();
}

/* ---------------------------------------------------------------------
   3D World mode — an alternative to the real map (see axieWorld.js for why
   this is a stylized procedural field rather than borrowed repo assets).
   Lazily created on first switch so a player who never leaves the map view
   never pays for a second WebGL scene.
   --------------------------------------------------------------------- */
let viewMode = 'map'; // 'map' | 'world'
let world = null;
const worldCanvas = document.getElementById('world-canvas');
const mapEl = document.getElementById('map');
const viewToggleBtn = document.getElementById('view-toggle-btn');
const viewToggleLabel = document.getElementById('view-toggle-label');

function currentAnimState() {
  if (!active) return 'idle';
  return mode === 'run' ? 'run' : 'walk';
}

async function ensureWorld() {
  if (world) return world;
  world = await createAxieWorld(worldCanvas, currentAxieId);
  world.setSpeedState(currentAnimState());
  return world;
}

let bannerHiddenForWorld = false;
const mapBannerEl = document.getElementById('map-banner');
const axieRotateBtn = document.getElementById('axie-rotate-btn');

async function switchToWorldView() {
  viewMode = 'world';
  viewToggleLabel.textContent = 'Map';
  mapEl.hidden = true;
  worldCanvas.hidden = false; // always show on the way in — ensureWorld() only builds the scene once
  if (!overlayFallback) axie3dWrap.hidden = true;
  if (axieRotateBtn) axieRotateBtn.hidden = true;
  if (!mapBannerEl.hidden) { bannerHiddenForWorld = true; mapBannerEl.hidden = true; }
  await ensureWorld();
  world.resize();
  world.setSpeedState(currentAnimState());
}

function switchToMapView() {
  viewMode = 'map';
  viewToggleLabel.textContent = '3D World';
  worldCanvas.hidden = true;
  mapEl.hidden = false;
  if (!overlayFallback) axie3dWrap.hidden = false;
  if (axieRotateBtn) axieRotateBtn.hidden = false;
  if (bannerHiddenForWorld) { mapBannerEl.hidden = false; bannerHiddenForWorld = false; }
  setTimeout(() => { map.invalidateSize(); positionOverlay(); }, 50);
}

viewToggleBtn.addEventListener('click', () => {
  if (viewMode === 'map') switchToWorldView();
  else switchToMapView();
});

axieRotateBtn?.addEventListener('click', () => {
  if (axie3d && axie3d.rotate180) axie3d.rotate180();
});

// Keeps whichever view is on screen playing the right Idle/Walk/Run clip —
// called everywhere the old code called axie3d.playAction(...) directly.
function setAxieAnimState(animState) {
  const clip = animState === 'run' ? 'Run' : animState === 'walk' ? 'Walk' : 'Idle';
  if (axie3d) axie3d.playAction(clip);
  if (world) world.setSpeedState(animState);
}

async function setCurrentAxie(id) {
  currentAxieId = id;
  state.selectedAxie = id;
  persistState();
  axieAvatarImg.src = portraitPath(id);
  const tasks = [];
  if (axie3d && axie3d.setCharacter) tasks.push(axie3d.setCharacter(id));
  if (world) tasks.push(world.setCharacter(id));
  await Promise.all(tasks);
}

// Centers the map on your real position ONCE, right when the app opens —
// separate from starting a tracking session. Without this the map just sits
// on a fixed demo coordinate (a Chennai park) until you press GO, which
// looks like a random/wrong location if you're anywhere else in the world.
// This does NOT start GPS tracking/logging — only GO does that.
function centerOnRealLocationOnce() {
  if (!('geolocation' in navigator)) return;
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const { latitude: lat, longitude: lng } = pos.coords;
      map.setView([lat, lng], 17, { animate: false });
      updateAxiePosition(lat, lng);
    },
    (err) => {
      console.warn('could not get an initial location fix, staying on the demo center', err);
    },
    { enableHighAccuracy: false, timeout: 8000, maximumAge: 60000 }
  );
}

function waitForTilesLoaded(timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (done) return; done = true; tileLayer.off('load', finish); resolve(); };
    tileLayer.once('load', finish);
    setTimeout(finish, timeoutMs);
  });
}

/* ---------------------------------------------------------------------
   Session state
   --------------------------------------------------------------------- */
let mode = 'walk';
let active = false;
let trackingMode = null; // 'live' | 'simulated'
let watchId = null;
let simTimer = null;
let simAngle = 0;
let lastFix = null; // { lat, lng, t }
let sessionKm = 0;
let sessionSteps = 0;
let sessionBaxs = 0;
let elapsedSec = 0;
let sessionStartedAt = null;
let tickTimer = null;
let usingNativeTracking = false; // true once LocationTracking.start() actually succeeded for this session
let nativeLocationSupported = null; // cached LocationTracking.isSupported() result

const el = {
  statStrip: document.getElementById('stat-strip'),
  km: document.getElementById('stat-km'),
  time: document.getElementById('stat-time'),
  baxs: document.getElementById('stat-baxs'),
  goBtn: document.getElementById('go-btn'),
  pauseBtn: document.getElementById('pause-btn'),
  resumeBtn: document.getElementById('resume-btn'),
  stopBtn: document.getElementById('stop-btn'),
  gpsTag: document.getElementById('gps-tag'),
  gpsTagText: document.getElementById('gps-tag-text'),
  mapBanner: document.getElementById('map-banner'),
  toast: document.getElementById('toast'),
  splash: document.getElementById('splash'),
  splashCta: document.getElementById('splash-cta'),
};

function render() {
  el.km.textContent = (state.totalKm + sessionKm).toFixed(2);
  el.time.textContent = fmtTime(elapsedSec);
  el.baxs.textContent = (state.totalBaxs + sessionBaxs).toFixed(3);
}

function showToast(msg) {
  el.toast.textContent = msg;
  el.toast.dataset.show = 'true';
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => { el.toast.dataset.show = 'false'; }, 1800);
}

function setGpsState(kind, text) { el.gpsTag.dataset.state = kind; el.gpsTagText.textContent = text; }
function showBanner(text, tone) { el.mapBanner.textContent = text; el.mapBanner.dataset.tone = tone || ''; el.mapBanner.hidden = false; }
function hideBanner() { el.mapBanner.hidden = true; }

/* ---------------------------------------------------------------------
   Tabs
   --------------------------------------------------------------------- */
const views = {
  track: document.getElementById('view-track'),
  activity: document.getElementById('view-activity'),
  leaderboard: document.getElementById('view-leaderboard'),
  challenge: document.getElementById('view-challenge'),
};
let currentTab = 'track';
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});
function switchTab(tab) {
  currentTab = tab;
  Object.entries(views).forEach(([key, node]) => { node.hidden = key !== tab; });
  document.querySelectorAll('.tab-btn').forEach((b) => { b.dataset.active = String(b.dataset.tab === tab); });
  if (tab === 'activity') renderActivityTab();
  if (tab === 'leaderboard') renderLeaderboardTab();
  if (tab === 'challenge') { renderChallengeTab(); startChallengeTicker(); } else { stopChallengeTicker(); }
  if (tab === 'track') setTimeout(() => { map.invalidateSize(); positionOverlay(); }, 50);
}

/* ---------------------------------------------------------------------
   Distance accounting (haversine)
   --------------------------------------------------------------------- */
function addDistanceMeters(m) {
  if (m <= 0) return;
  sessionKm += m / 1000;
  sessionSteps += m / STRIDE_M;
  sessionBaxs = sessionSteps * BAXS_PER_STEP;
  render();
}

function applyFix(lat, lng, accuracy, tsMs) {
  const point = { lat, lng, t: tsMs };
  updateAxiePosition(lat, lng);
  trail.addLatLng([lat, lng]);
  map.panTo([lat, lng], { animate: true });

  if (lastFix) {
    const dtSec = Math.max(0.001, (tsMs - lastFix.t) / 1000);
    const distM = haversineMeters(lastFix, point);
    const speed = distM / dtSec;
    const goodAccuracy = accuracy == null || accuracy <= MIN_ACCURACY_M;
    const plausible = speed <= MAX_PLAUSIBLE_SPEED_MPS;
    if (goodAccuracy && plausible) {
      addDistanceMeters(distM);
      if (world) world.advance(distM); // same real distance the map/stats use — not a separate simulation
    }

    // Turn the 3D Axie to face the way it's actually walking: convert the
    // real lat/lng delta into local east/north meters, then into the
    // overlay's own ground-plane convention (east -> +x, north -> -z) so a
    // walk toward map-north turns the character to face "into" the scene,
    // matching the map's north-up orientation.
    if (axie3d && distM > 0.15) {
      const midLat = (lastFix.lat + lat) / 2;
      const dNorth = (lat - lastFix.lat) * 110540;
      const dEast = (lng - lastFix.lng) * 111320 * Math.cos(midLat * Math.PI / 180);
      axie3d.setHeading(dEast, -dNorth);
    }
  }
  lastFix = point;
}

/* ---------------------------------------------------------------------
   Simulated fallback (no location permission / unavailable)
   --------------------------------------------------------------------- */
function startSimulated() {
  trackingMode = 'simulated';
  setGpsState('simulated', 'Simulated route');
  showBanner('Location unavailable — showing a simulated demo route.', 'warn');
  lastFix = { lat: SIM_CENTER.lat, lng: SIM_CENTER.lng, t: Date.now() };
  const RADIUS_DEG = 0.00045; // ~50m loop, small enough to read clearly on the map
  let last = Date.now();
  simTimer = setInterval(() => {
    const now = Date.now();
    const dt = (now - last) / 1000;
    last = now;
    const speed = SIM_SPEED_MPS[mode];
    simAngle += (speed * dt) / (RADIUS_DEG * 111320); // approx meters-per-degree
    const lat = SIM_CENTER.lat + Math.sin(simAngle) * RADIUS_DEG;
    const lng = SIM_CENTER.lng + Math.cos(simAngle) * RADIUS_DEG * 1.05;
    applyFix(lat, lng, 5, now);
  }, 1000);
}
function stopSimulated() { if (simTimer) { clearInterval(simTimer); simTimer = null; } }

/* ---------------------------------------------------------------------
   Real GPS tracking
   --------------------------------------------------------------------- */
function startLiveTracking() {
  if (!('geolocation' in navigator)) { startSimulated(); return; }

  navigator.geolocation.getCurrentPosition(
    () => {
      trackingMode = 'live';
      setGpsState('live', 'GPS live');
      hideBanner();
      let lastGoodFixAt = Date.now();
      let lostSignalNotified = false;
      watchId = navigator.geolocation.watchPosition(
        (pos) => {
          lastGoodFixAt = Date.now();
          lostSignalNotified = false;
          applyFix(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy, pos.timestamp);
        },
        (err) => {
          console.warn('geolocation watch error', err);
          if (!lostSignalNotified && Date.now() - lastGoodFixAt > 8000) {
            lostSignalNotified = true;
            showToast('Lost GPS signal');
          }
        },
        { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 }
      );
    },
    (err) => {
      console.warn('geolocation denied/unavailable', err);
      startSimulated();
    },
    { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 }
  );
}

function stopTracking() {
  if (watchId != null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
  stopSimulated();
}

/* ---------------------------------------------------------------------
   Native background GPS tracking (Android only — see src/locationTracking.js)

   Runs the actual GPS subscription + distance/time accounting inside a
   native foreground service (LocationTrackingService.kt) instead of this
   WebView, so a session keeps tracking — and its own persistent
   notification keeps showing live Walk/Run status — even after the phone
   locks. While the app is open we still get every accepted fix pushed here
   live ('locationUpdated'), used to drive the map/trail/3D character; the
   authoritative km/steps/$bAXS/elapsed numbers always come from the native
   side on every update so nothing ever double-counts against the old
   watchPosition-based path below.
   --------------------------------------------------------------------- */
/**
 * Requests every permission the app uses, in sequence with a real pause
 * between each: Location -> Physical Activity + Notifications (Android
 * bundles those two into one StepCounter request) -> Health Connect.
 *
 * The pause matters — Android only ever has one permission dialog in
 * flight at a time, and firing a second requestPermissions() call the
 * instant the first one's callback resolves lands while the OS is still
 * tearing down that first dialog's UI. It doesn't queue the second
 * request, it just silently drops it (comes back denied with no dialog
 * ever shown), which is exactly why chaining "Physical Activity" straight
 * off the back of the location prompt wasn't actually showing anything.
 *
 * Called both on first open (see the splash CTA handler) and again from
 * the GO flow as a fallback for anyone who skipped/dismissed onboarding —
 * safe to call repeatedly since an already-granted permission just
 * resolves immediately with no dialog and no user-visible effect.
 */
/**
 * Requests Location, then Physical Activity + Notifications, then Health
 * Connect — in that order — checking each permission group first and only
 * calling requestPermissions()/delaying when a dialog is actually about to
 * be shown. This makes the function cheap and safe to call from BOTH the
 * first-open onboarding flow and every GO tap: an already-granted (or
 * already-denied) group resolves instantly with zero dialogs and zero
 * added delay, while a group that's still unresolved gets its dialog and
 * the 600ms tear-down gap before the next one fires. Always await this —
 * calling it fire-and-forget reintroduces the exact "second dialog gets
 * silently dropped" race this function exists to prevent.
 *
 * Returns { locationGranted, stepsGranted } so callers can react.
 */
async function requestAllCorePermissions() {
  if (!isNative) return { locationGranted: false, stepsGranted: false };

  let locationGranted = false;
  try {
    if (nativeLocationSupported == null) {
      nativeLocationSupported = (await LocationTracking.isSupported()).supported;
    }
    if (nativeLocationSupported) {
      let status = await LocationTracking.checkPermissions();
      if (status.location !== 'granted') {
        status = await LocationTracking.requestPermissions();
        await delay(600); // a dialog was just shown — let Android fully tear it down
      }
      locationGranted = status.location === 'granted';
    }
  } catch (e) {
    console.warn('location permission request failed', e);
  }

  let stepsGranted = false;
  try {
    const supported = await StepCounter.isSupported();
    if (supported.supported) {
      let perms = await StepCounter.checkPermissions();
      if (perms.activity !== 'granted' || perms.notifications !== 'granted') {
        perms = await StepCounter.requestPermissions(); // bundles Physical Activity + Notifications
        await delay(600);
      }
      stepsGranted = perms.activity === 'granted';
      if (stepsGranted) {
        const today = await StepCounter.getTodaySteps();
        if (!today.tracking) {
          await StepCounter.start();
          refreshBgSteps();
        }
      }
    }
  } catch (e) {
    console.warn('step tracking permission request failed', e);
  }

  try {
    const avail = await StepCounter.isHealthConnectAvailable();
    if (avail.available) {
      await StepCounter.requestHealthConnectPermissions();
      refreshHealthConnect();
    }
  } catch (e) {
    // Health Connect not installed, or the user declined — neither is
    // worth surfacing during silent onboarding; the Activity tab's own
    // "Sync with Health Connect" button reports failures explicitly.
    console.warn('Health Connect permission request failed', e);
  }

  return { locationGranted, stepsGranted };
}

function handleNativeLocationUpdate(data) {
  const lat = data.lat, lng = data.lng;
  if (typeof lat === 'number' && typeof lng === 'number') {
    updateAxiePosition(lat, lng);
    trail.addLatLng([lat, lng]);
    map.panTo([lat, lng], { animate: true });
    if (lastFix && axie3d) {
      const distM = haversineMeters(lastFix, { lat, lng });
      if (distM > 0.15) {
        const midLat = (lastFix.lat + lat) / 2;
        const dNorth = (lat - lastFix.lat) * 110540;
        const dEast = (lng - lastFix.lng) * 111320 * Math.cos(midLat * Math.PI / 180);
        axie3d.setHeading(dEast, -dNorth);
      }
    }
    lastFix = { lat, lng, t: data.tsMs || Date.now() };
  }
  // Native distance/steps/$bAXS/elapsed are the source of truth — they keep
  // accumulating through stretches the WebView never saw (screen locked), so
  // always resync to them rather than adding on top of what's here already.
  if (typeof data.distanceKm === 'number') {
    const prevKm = sessionKm;
    sessionKm = data.distanceKm;
    if (typeof data.steps === 'number') sessionSteps = data.steps;
    if (typeof data.baxs === 'number') sessionBaxs = data.baxs;
    if (world && data.distanceKm > prevKm) world.advance((data.distanceKm - prevKm) * 1000);
  }
  if (typeof data.elapsedSec === 'number') elapsedSec = data.elapsedSec;
  render();
  if (trackingMode !== 'live') {
    trackingMode = 'live';
    setGpsState('live', 'GPS live');
    hideBanner();
  }
}

LocationTracking.addListener('locationUpdated', handleNativeLocationUpdate);

async function startNativeTracking() {
  usingNativeTracking = false;
  if (nativeLocationSupported == null) {
    nativeLocationSupported = (await LocationTracking.isSupported()).supported;
  }
  if (!nativeLocationSupported) { startLiveTracking(); return; }
  try {
    // Single, sequenced permission pass — Location, then Steps/Notifications,
    // then Health Connect. Safe (and cheap) to call on every GO tap: it also
    // covers anyone who skipped/dismissed first-open onboarding, since each
    // already-granted group is a no-op and only an unresolved one shows a
    // dialog. Must be awaited — see requestAllCorePermissions()'s comment.
    const { locationGranted } = await requestAllCorePermissions();
    if (!locationGranted) {
      showToast('Location permission is required to track your walk or run');
      startSimulated();
      return;
    }
    setGpsState('idle', 'Locating…');
    hideBanner();
    await LocationTracking.start({ mode });
    usingNativeTracking = true;
  } catch (e) {
    console.warn('native GPS tracking failed, falling back to in-app tracking', e);
    startLiveTracking();
  }
}

async function pauseNativeTracking() {
  try { await LocationTracking.pause(); } catch (e) { console.warn('could not pause native tracking', e); }
}
async function resumeNativeTracking() {
  try { await LocationTracking.resume(); } catch (e) { console.warn('could not resume native tracking', e); }
}
async function stopNativeTracking() {
  try {
    const final = await LocationTracking.stop();
    if (typeof final.distanceKm === 'number') sessionKm = final.distanceKm;
    if (typeof final.steps === 'number') sessionSteps = final.steps;
    if (typeof final.baxs === 'number') sessionBaxs = final.baxs;
    if (typeof final.elapsedSec === 'number') elapsedSec = final.elapsedSec;
  } catch (e) {
    console.warn('could not stop native tracking cleanly', e);
  }
  usingNativeTracking = false;
}

/* ---------------------------------------------------------------------
   Mode toggle
   --------------------------------------------------------------------- */
const modeToggle = document.getElementById('mode-toggle');
document.querySelectorAll('#mode-toggle .mode-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    // Locked once a session has started (active or paused) — the mode is
    // fixed for the whole session and only selectable again after Stop.
    if (modeToggle.dataset.locked === 'true') return;
    mode = btn.dataset.mode;
    document.querySelectorAll('#mode-toggle .mode-btn').forEach((b) => b.dataset.selected = String(b === btn));
  });
});

/* ---------------------------------------------------------------------
   Controls — GO -> Pause/Resume -> Stop (saves + offers share)
   --------------------------------------------------------------------- */
function setControlState(s) {
  el.goBtn.hidden = s !== 'idle';
  el.pauseBtn.hidden = s !== 'active';
  el.resumeBtn.hidden = s !== 'paused';
  el.stopBtn.hidden = s !== 'paused';
  el.statStrip.hidden = s === 'idle';
  const locked = s !== 'idle';
  modeToggle.dataset.locked = String(locked);
  document.querySelectorAll('#mode-toggle .mode-btn').forEach((b) => { b.disabled = locked; });
}

function startSession() {
  active = true;
  sessionStartedAt = Date.now();
  setControlState('active');
  setGpsState('idle', 'Locating…');
  if (isNative) startNativeTracking(); else startLiveTracking();
  setAxieAnimState(mode === 'run' ? 'run' : 'walk');
  tickTimer = setInterval(() => { elapsedSec += 1; render(); }, 1000);
}
function pauseSession() {
  active = false;
  setControlState('paused');
  clearInterval(tickTimer);
  if (usingNativeTracking) pauseNativeTracking(); else stopTracking();
  lastFix = null; // avoid one large jump-distance segment across the pause gap
  setGpsState('idle', 'Paused');
  hideBanner();
  setAxieAnimState('idle');
}
function resumeSession() {
  active = true;
  setControlState('active');
  setGpsState('idle', 'Locating…');
  if (usingNativeTracking) resumeNativeTracking();
  else if (isNative) startNativeTracking();
  else startLiveTracking();
  setAxieAnimState(mode === 'run' ? 'run' : 'walk');
  tickTimer = setInterval(() => { elapsedSec += 1; render(); }, 1000);
}
async function stopSession() {
  if (active) clearInterval(tickTimer);
  if (usingNativeTracking) await stopNativeTracking(); else stopTracking();
  const routePoints = trail.getLatLngs().map((p) => [round6(p.lat), round6(p.lng)]);
  let savedActivity = null;
  if (sessionKm > 0 || sessionSteps > 0) {
    savedActivity = {
      id: uuid(),
      type: mode,
      distanceKm: sessionKm,
      durationSec: elapsedSec,
      steps: Math.round(sessionSteps),
      baxs: sessionBaxs,
      startedAt: sessionStartedAt || Date.now(),
      endedAt: Date.now(),
      points: downsample(routePoints, MAX_ROUTE_POINTS),
    };
    state.activities.unshift(savedActivity);
    state.totalKm += sessionKm;
    state.totalBaxs += sessionBaxs;
    state.totalSteps += sessionSteps;
    // Counts toward every pool you're currently enrolled in, not just one.
    Object.values(state.challenges.active).forEach((entry) => {
      if (Date.now() < entry.endsAt) entry.distanceKm += savedActivity.distanceKm;
    });
    persistState();
    showToast(`Saved +${savedActivity.baxs.toFixed(3)} $bAXS`);
  }
  active = false;
  setControlState('idle');
  setGpsState('idle', 'GPS ready');
  hideBanner();
  setAxieAnimState('idle');
  sessionKm = 0; sessionSteps = 0; sessionBaxs = 0; elapsedSec = 0; sessionStartedAt = null; lastFix = null;
  trail.setLatLngs([]);
  render();
  if (savedActivity) offerShare(savedActivity);
}
function round6(n) { return Math.round(n * 1e6) / 1e6; }

el.goBtn.addEventListener('click', startSession);
el.pauseBtn.addEventListener('click', pauseSession);
el.resumeBtn.addEventListener('click', resumeSession);
el.stopBtn.addEventListener('click', stopSession);

/* ---------------------------------------------------------------------
   Activity tab: history + overall stats + charts
   --------------------------------------------------------------------- */
let activityTypeFilter = 'all';
document.querySelectorAll('#activity-type-row .pill-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    activityTypeFilter = btn.dataset.type;
    document.querySelectorAll('#activity-type-row .pill-btn').forEach((b) => b.dataset.selected = String(b === btn));
    renderActivityList();
  });
});

function renderActivityTab() {
  const totals = computeTotals(state.activities);
  document.getElementById('ov-km').textContent = totals.km.toFixed(2);
  document.getElementById('ov-count').textContent = String(totals.count);
  document.getElementById('ov-baxs').textContent = totals.baxs.toFixed(3);
  document.getElementById('ov-streak').textContent = String(computeStreak(state.activities));
  refreshBgSteps();
  refreshHealthConnect();

  const chartsWrap = document.getElementById('activity-charts');
  const typeRow = document.getElementById('activity-type-row');

  if (!state.activities.length) {
    document.getElementById('activity-empty').hidden = false;
    chartsWrap.hidden = true;
    typeRow.hidden = true;
    document.getElementById('activity-list').innerHTML = '';
    return;
  }
  chartsWrap.hidden = false;
  typeRow.hidden = false;
  renderActivityList();

  drawWeekChart();
  drawSplitChart(totals);
  drawGrowthChart();
  drawPaceChart();
  drawWeekdayChart();
  renderPersonalBests();
}

function renderPersonalBests() {
  const acts = state.activities;
  const bestKmEl = document.getElementById('best-km');
  const bestPaceEl = document.getElementById('best-pace');
  const bestBaxsEl = document.getElementById('best-baxs');
  if (!acts.length) {
    bestKmEl.textContent = '\u2014';
    bestPaceEl.textContent = '\u2014';
    bestBaxsEl.textContent = '\u2014';
    return;
  }
  const bestKm = Math.max(...acts.map((a) => a.distanceKm));
  const bestBaxs = Math.max(...acts.map((a) => a.baxs));
  const paces = acts
    .filter((a) => a.distanceKm > 0.05)
    .map((a) => (a.durationSec / 60) / a.distanceKm);
  const bestPace = paces.length ? Math.min(...paces) : null;
  bestKmEl.textContent = bestKm.toFixed(2);
  bestPaceEl.textContent = bestPace ? bestPace.toFixed(1) : '\u2014';
  bestBaxsEl.textContent = bestBaxs.toFixed(3);
}

function renderActivityList() {
  const list = document.getElementById('activity-list');
  const empty = document.getElementById('activity-empty');
  list.innerHTML = '';

  const filtered = activityTypeFilter === 'all' ? state.activities : state.activities.filter((a) => a.type === activityTypeFilter);

  if (!filtered.length) {
    empty.hidden = false;
    empty.querySelector('.big').textContent = activityTypeFilter === 'all' ? 'No activities yet' : `No ${activityTypeFilter}s yet`;
    empty.querySelector('.small').textContent = activityTypeFilter === 'all' ? 'Head to Track and hit GO to log your first walk or run.' : `Log a ${activityTypeFilter} from Track to see it here.`;
    return;
  }
  empty.hidden = true;

  let lastDay = null;
  for (const a of filtered) {
    const day = dayLabel(a.startedAt);
    if (day !== lastDay) {
      const h = document.createElement('div');
      h.className = 'day-header';
      h.textContent = day;
      list.appendChild(h);
      lastDay = day;
    }
    const row = document.createElement('div');
    row.className = 'activity-row';
    row.innerHTML = `
      <div class="activity-badge" data-type="${a.type}">${a.type === 'run' ? 'RUN' : 'WLK'}</div>
      <div class="activity-main">
        <div class="activity-title">${a.type === 'run' ? 'Run' : 'Walk'} &middot; ${timeLabel(a.startedAt)}</div>
        <div class="activity-sub">${fmtTime(a.durationSec)} &middot; ${a.steps.toLocaleString()} steps</div>
      </div>
      <div class="activity-end">
        <div class="activity-baxs">+${a.baxs.toFixed(3)}</div>
        <div class="activity-km">${a.distanceKm.toFixed(2)} km</div>
      </div>
      <button class="share-icon-btn" data-id="${a.id}" aria-label="Share activity">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 13.5 15.4 17.5M15.4 6.5 8.6 10.5"/></svg>
      </button>`;
    row.querySelector('.share-icon-btn').addEventListener('click', () => {
      const activity = state.activities.find((x) => x.id === a.id);
      if (activity) offerShare(activity);
    });
    list.appendChild(row);
  }
}

function setupHiDPICanvas(canvas, cssHeight) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cssWidth = canvas.parentElement.clientWidth - 32; // minus card padding
  canvas.style.width = cssWidth + 'px';
  canvas.style.height = cssHeight + 'px';
  canvas.width = cssWidth * dpr;
  canvas.height = cssHeight * dpr;
  const c = canvas.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { c, w: cssWidth, h: cssHeight };
}

function drawWeekChart() {
  const canvas = document.getElementById('chart-week');
  const { c, w, h } = setupHiDPICanvas(canvas, 120);
  c.clearRect(0, 0, w, h);

  const days = [];
  for (let i = 6; i >= 0; i--) { const d = new Date(); d.setDate(d.getDate() - i); days.push(d); }
  const buckets = computeDailyBuckets(state.activities, 7);
  const values = days.map((d) => (buckets[dateKey(d.getTime())]?.km) || 0);
  const maxV = Math.max(...values, 0.5);

  const padL = 4, padB = 18, padT = 6;
  const chartW = w - padL * 2, chartH = h - padB - padT;
  const barW = Math.min(30, (chartW / days.length) * 0.55);
  const gap = chartW / days.length;

  const textFaint = '#59595f', amber = '#ff9d2e', mint = '#6be3a6';
  c.font = '10px Manrope, sans-serif';
  c.fillStyle = textFaint;
  c.textAlign = 'center';

  days.forEach((d, i) => {
    const v = values[i];
    const barH = (v / maxV) * chartH;
    const x = padL + gap * i + gap / 2;
    const isToday = i === days.length - 1;
    c.fillStyle = isToday ? amber : mint;
    c.globalAlpha = isToday ? 1 : 0.55;
    const y = padT + chartH - barH;
    const r = 4;
    c.beginPath();
    c.moveTo(x - barW / 2, padT + chartH);
    c.lineTo(x - barW / 2, y + r);
    c.arcTo(x - barW / 2, y, x - barW / 2 + r, y, r);
    c.lineTo(x + barW / 2 - r, y);
    c.arcTo(x + barW / 2, y, x + barW / 2, y + r, r);
    c.lineTo(x + barW / 2, padT + chartH);
    c.closePath();
    c.fill();
    c.globalAlpha = 1;
    c.fillStyle = textFaint;
    c.fillText(d.toLocaleDateString(undefined, { weekday: 'narrow' }), x, h - 4);
  });
}

function drawSplitChart(totals) {
  const canvas = document.getElementById('chart-split');
  const { c, w, h } = setupHiDPICanvas(canvas, 140);
  c.clearRect(0, 0, w, h);
  const cx = w / 2, cy = h / 2, rOuter = Math.min(w, h) / 2 - 6, rInner = rOuter * 0.62;
  const walkKm = state.activities.filter((a) => a.type !== 'run').reduce((s, a) => s + a.distanceKm, 0);
  const runKm = state.activities.filter((a) => a.type === 'run').reduce((s, a) => s + a.distanceKm, 0);
  const total = walkKm + runKm;
  const walkFrac = total > 0 ? walkKm / total : 0.5;

  const start = -Math.PI / 2;
  c.lineWidth = rOuter - rInner;
  const ringR = (rOuter + rInner) / 2;

  c.beginPath();
  c.arc(cx, cy, ringR, start, start + Math.PI * 2 * walkFrac);
  c.strokeStyle = '#6be3a6';
  c.stroke();

  c.beginPath();
  c.arc(cx, cy, ringR, start + Math.PI * 2 * walkFrac, start + Math.PI * 2);
  c.strokeStyle = '#ff9d2e';
  c.stroke();

  c.fillStyle = '#f5f5f7';
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.font = '700 17px "JetBrains Mono", monospace';
  c.fillText(total.toFixed(2), cx, cy - 6);
  c.font = '700 9px Manrope, sans-serif';
  c.fillStyle = '#8b8b93';
  c.fillText('TOTAL KM', cx, cy + 12);
}

function drawGrowthChart() {
  const canvas = document.getElementById('chart-growth');
  const { c, w, h } = setupHiDPICanvas(canvas, 120);
  c.clearRect(0, 0, w, h);
  const chrono = [...state.activities].sort((a, b) => a.endedAt - b.endedAt);
  let cum = 0;
  const pts = chrono.map((a) => { cum += a.baxs; return cum; });
  if (!pts.length) return;
  const maxV = Math.max(...pts, 0.001);
  const padL = 4, padR = 4, padT = 10, padB = 8;
  const chartW = w - padL - padR, chartH = h - padT - padB;

  function xAt(i) { return padL + (pts.length === 1 ? chartW : (chartW * i) / (pts.length - 1)); }
  function yAt(v) { return padT + chartH - (v / maxV) * chartH; }

  const grad = c.createLinearGradient(0, padT, 0, padT + chartH);
  grad.addColorStop(0, 'rgba(255,157,46,0.35)');
  grad.addColorStop(1, 'rgba(255,157,46,0)');
  c.beginPath();
  c.moveTo(xAt(0), padT + chartH);
  pts.forEach((v, i) => c.lineTo(xAt(i), yAt(v)));
  c.lineTo(xAt(pts.length - 1), padT + chartH);
  c.closePath();
  c.fillStyle = grad;
  c.fill();

  c.beginPath();
  pts.forEach((v, i) => { const x = xAt(i), y = yAt(v); if (i === 0) c.moveTo(x, y); else c.lineTo(x, y); });
  c.strokeStyle = '#ff9d2e';
  c.lineWidth = 2.5;
  c.lineJoin = 'round';
  c.stroke();
}

function drawPaceChart() {
  const canvas = document.getElementById('chart-pace');
  const { c, w, h } = setupHiDPICanvas(canvas, 120);
  c.clearRect(0, 0, w, h);
  const chrono = [...state.activities]
    .sort((a, b) => a.endedAt - b.endedAt)
    .filter((a) => a.distanceKm > 0.05);
  if (!chrono.length) return;
  const paces = chrono.map((a) => (a.durationSec / 60) / a.distanceKm); // min per km, lower is faster
  const minV = Math.min(...paces) * 0.92;
  const maxV = Math.max(...paces) * 1.08;
  const span = Math.max(maxV - minV, 0.5);
  const padL = 4, padR = 4, padT = 10, padB = 8;
  const chartW = w - padL - padR, chartH = h - padT - padB;

  function xAt(i) { return padL + (paces.length === 1 ? chartW / 2 : (chartW * i) / (paces.length - 1)); }
  function yAt(v) { return padT + chartH - ((v - minV) / span) * chartH; } // faster (lower) pace sits higher

  c.beginPath();
  paces.forEach((v, i) => { const x = xAt(i), y = yAt(v); if (i === 0) c.moveTo(x, y); else c.lineTo(x, y); });
  c.strokeStyle = '#6be3a6';
  c.lineWidth = 2.5;
  c.lineJoin = 'round';
  c.stroke();

  const bestIdx = paces.indexOf(Math.min(...paces));
  c.beginPath();
  c.arc(xAt(bestIdx), yAt(paces[bestIdx]), 4, 0, Math.PI * 2);
  c.fillStyle = '#ff9d2e';
  c.fill();

  // Fixed corner label (not tied to the dot's position) so it never sits
  // on top of the line itself, whichever end the fastest session lands on.
  const label = `Best ${paces[bestIdx].toFixed(1)} min/km`;
  c.font = '700 10px "JetBrains Mono", monospace';
  const labelW = c.measureText(label).width;
  c.fillStyle = 'rgba(19,19,22,0.82)';
  c.fillRect(0, 0, labelW + 10, 16);
  c.fillStyle = '#8b8b93';
  c.textAlign = 'left';
  c.textBaseline = 'top';
  c.fillText(label, 4, 3);
  c.textBaseline = 'alphabetic';
}

const WEEKDAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

function drawWeekdayChart() {
  const canvas = document.getElementById('chart-weekday');
  const { c, w, h } = setupHiDPICanvas(canvas, 120);
  c.clearRect(0, 0, w, h);

  const sums = new Array(7).fill(0);
  const counts = new Array(7).fill(0);
  state.activities.forEach((a) => {
    const d = new Date(a.startedAt).getDay();
    sums[d] += a.distanceKm;
    counts[d] += 1;
  });
  const avgs = sums.map((s, i) => (counts[i] ? s / counts[i] : 0));
  const maxV = Math.max(...avgs, 0.5);

  const padL = 4, padB = 18, padT = 6;
  const chartW = w - padL * 2, chartH = h - padB - padT;
  const barW = Math.min(30, (chartW / 7) * 0.55);
  const gap = chartW / 7;
  const textFaint = '#59595f', mint = '#6be3a6';

  c.font = '10px Manrope, sans-serif';
  c.textAlign = 'center';

  for (let i = 0; i < 7; i++) {
    const v = avgs[i];
    const barH = (v / maxV) * chartH;
    const x = padL + gap * i + gap / 2;
    const y = padT + chartH - barH;
    c.fillStyle = mint;
    c.globalAlpha = counts[i] ? 0.85 : 0.18;
    const r = 4;
    c.beginPath();
    c.moveTo(x - barW / 2, padT + chartH);
    c.lineTo(x - barW / 2, y + r);
    c.arcTo(x - barW / 2, y, x - barW / 2 + r, y, r);
    c.lineTo(x + barW / 2 - r, y);
    c.arcTo(x + barW / 2, y, x + barW / 2, y + r, r);
    c.lineTo(x + barW / 2, padT + chartH);
    c.closePath();
    c.fill();
    c.globalAlpha = 1;
    c.fillStyle = textFaint;
    c.fillText(WEEKDAY_LABELS[i], x, h - 4);
  }
}

/* ---------------------------------------------------------------------
   Leaderboard tab — see file header: this is shaped like a real multiplayer
   leaderboard (period + Walk/Run tabs, ranked rows) but only ever has one
   real row ("You"), since this standalone build has no shared backend yet.
   --------------------------------------------------------------------- */
let lbPeriod = 'day';
let lbType = 'walk';
document.querySelectorAll('#lb-period-row .pill-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    lbPeriod = btn.dataset.period;
    document.querySelectorAll('#lb-period-row .pill-btn').forEach((b) => b.dataset.selected = String(b === btn));
    renderLeaderboardTab();
  });
});
document.querySelectorAll('#lb-type-row .mode-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    lbType = btn.dataset.lbtype;
    document.querySelectorAll('#lb-type-row .mode-btn').forEach((b) => b.dataset.selected = String(b === btn));
    renderLeaderboardTab();
  });
});

const PERIOD_LABEL = { day: 'today', week: 'this week', month: 'this month' };

/* ---------------------------------------------------------------------
   Demo leaderboard roster — this standalone build has no shared backend
   (see the note rendered above the list), so with real multiplayer data
   there is nothing to rank against. Fifty seeded example trainers fill the
   board instead, clearly labeled as examples, so judges can see what a
   populated leaderboard looks like. Each row cycles through the app's own
   7-Axie roster for its portrait (jaatster/axie-3d-assets only ships 7
   mascot characters, so portraits repeat every 7 rows rather than being
   fully unique — that's the real limit of the asset pack, not a bug).
   Values are seeded per period+type so they stay put while you browse
   instead of reshuffling on every render.
   --------------------------------------------------------------------- */
const DEMO_TRAINER_NAMES = [
  'Aiko Tanaka', 'Marcus Webb', 'Priya Nair', 'Liam O\'Connor', 'Sofia Rossi',
  'Kenji Sato', 'Amara Okafor', 'Diego Fernandez', 'Elena Petrova', 'Noah Kim',
  'Mei Lin', 'Ravi Shankar', 'Chloe Dubois', 'Tomas Novak', 'Zainab Ahmed',
  'Lucas Silva', 'Hannah Cohen', 'Yusuf Demir', 'Ingrid Larsen', 'Ben Carter',
  'Mateo Garcia', 'Nadia Hassan', 'Oliver Wright', 'Freya Andersen', 'Arjun Mehta',
  'Isla Murphy', 'Kwame Mensah', 'Valentina Cruz', 'Felix Bauer', 'Grace Odom',
  'Hiro Nakamura', 'Layla Hussain', 'Connor Byrne', 'Sara Lindqvist', 'Ethan Brooks',
  'Mariana Alves', 'Omar Farouk', 'Ji-woo Park', 'Adaeze Obi', 'Milo Novak',
  'Talia Rosen', 'Bruno Conti', 'Nia Campbell', 'Rafael Torres', 'Yuki Ishikawa',
  'Esther Adeyemi', 'Simon Wagner', 'Pia Andersson', 'Ahmed El-Sayed', 'Clara Vidal',
];

function seededRand(seedStr) {
  // mulberry32, seeded from a string so a given period+type+index always
  // produces the same value — the board holds still while you browse it.
  let h = 0;
  for (let i = 0; i < seedStr.length; i++) { h = Math.imul(31, h) + seedStr.charCodeAt(i) | 0; }
  let a = h >>> 0 || 1;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DEMO_KM_RANGE = {
  day: [0.8, 14],
  week: [4, 68],
  month: [15, 260],
};

function buildDemoRows(period, type) {
  const [lo, hi] = DEMO_KM_RANGE[period];
  const rows = DEMO_TRAINER_NAMES.map((name, i) => {
    const rand = seededRand(`${period}:${type}:${i}:${name}`);
    const km = lo + rand() * (hi - lo);
    const sessions = Math.max(1, Math.round(km / (type === 'run' ? 6 : 3) * (0.6 + rand() * 0.8)));
    const axie = AXIES[i % AXIES.length];
    return { name, km, sessions, axieId: axie.id, isYou: false };
  });
  return rows;
}

function renderLeaderboardTab() {
  const since = periodStartMs(lbPeriod);
  const inWindow = state.activities.filter((a) => (a.endedAt || a.startedAt) >= since && a.type === lbType);
  const totals = computeTotals(inWindow);

  const list = document.getElementById('leaderboard-list');
  const empty = document.getElementById('leaderboard-empty');
  empty.hidden = true;
  list.innerHTML = '';

  const rows = buildDemoRows(lbPeriod, lbType);
  if (inWindow.length) {
    rows.push({ name: 'You', km: totals.km, sessions: totals.count, axieId: currentAxieId, isYou: true });
  }
  rows.sort((a, b) => b.km - a.km);

  rows.forEach((r, i) => {
    const row = document.createElement('div');
    row.className = 'leaderboard-row';
    if (r.isYou) row.dataset.you = 'true';
    row.innerHTML = `
      <div class="leaderboard-rank">${i + 1}</div>
      <img class="leaderboard-avatar" src="${portraitPath(r.axieId)}" alt="" />
      <div class="leaderboard-main">
        <div class="leaderboard-name">${r.name}</div>
        <div class="leaderboard-sub">${r.sessions} ${lbType} ${r.sessions === 1 ? 'session' : 'sessions'} ${PERIOD_LABEL[lbPeriod]}</div>
      </div>
      <div class="leaderboard-end">
        <div class="leaderboard-value">${r.km.toFixed(2)}</div>
        <div class="leaderboard-unit">km</div>
      </div>`;
    list.appendChild(row);
  });
}

/* ---------------------------------------------------------------------
   Axie picker — search the roster (from axieCatalog.js, sourced from the
   jaatster/axie-3d-assets GLB pack), preview any character rotating in 3D,
   and confirm to make it the Axie used everywhere (map overlay, 3D World,
   the flat-marker fallback).
   --------------------------------------------------------------------- */
const pickerOverlay = document.getElementById('picker-overlay');
const pickerGrid = document.getElementById('picker-grid');
const pickerSearch = document.getElementById('picker-search');
const pickerPreviewCanvas = document.getElementById('picker-preview-canvas');
const pickerPreviewName = document.getElementById('picker-preview-name');
const pickerConfirmBtn = document.getElementById('picker-confirm-btn');
const pickerCloseBtn = document.getElementById('picker-close-btn');
const axieAvatarBtn = document.getElementById('axie-avatar-btn');

let pickerPreview = null;
let pickerCandidateId = currentAxieId;

function renderPickerGrid(filterText) {
  const q = (filterText || '').trim().toLowerCase();
  const items = q ? AXIES.filter((a) => a.name.toLowerCase().includes(q)) : AXIES;
  pickerGrid.innerHTML = '';
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'picker-empty';
    empty.textContent = `No Axie matches "${filterText}"`;
    pickerGrid.appendChild(empty);
    return;
  }
  for (const a of items) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'picker-card';
    card.dataset.selected = String(a.id === pickerCandidateId);
    card.dataset.current = String(a.id === currentAxieId);
    card.innerHTML = `<img src="${portraitPath(a.id)}" alt="${a.name}" /><div class="picker-card-name">${a.name}</div>`;
    card.addEventListener('click', () => selectCandidate(a.id));
    pickerGrid.appendChild(card);
  }
}

async function selectCandidate(id) {
  pickerCandidateId = id;
  renderPickerGrid(pickerSearch.value);
  pickerPreviewName.textContent = getAxie(id).name;
  pickerConfirmBtn.disabled = true;
  if (!pickerPreview) pickerPreview = createCharacterPreview(pickerPreviewCanvas);
  const ok = await pickerPreview.show(id);
  pickerConfirmBtn.disabled = !ok;
}

pickerSearch.addEventListener('input', () => renderPickerGrid(pickerSearch.value));

axieAvatarBtn.addEventListener('click', () => {
  pickerOverlay.dataset.open = 'true';
  pickerSearch.value = '';
  renderPickerGrid('');
  selectCandidate(currentAxieId);
});
pickerCloseBtn.addEventListener('click', () => { pickerOverlay.dataset.open = 'false'; });
pickerConfirmBtn.addEventListener('click', async () => {
  const id = pickerCandidateId;
  await setCurrentAxie(id);
  pickerOverlay.dataset.open = 'false';
  showToast(`${getAxie(id).name} is your Axie now`);
});

/* ---------------------------------------------------------------------
   Challenge tab — three fixed pools (Beginner/Pro/Expert), each its own
   24-hour window. Same honesty as the Leaderboard tab: with no shared
   backend, you're the only real entrant, so "winning" just means you
   logged a walk or run before the window closes — see the note rendered
   in the tab itself. Entry fees and rewards move the same simulated
   $bAXS number the rest of the app uses; nothing here touches a wallet.
   --------------------------------------------------------------------- */
const CHALLENGE_POOLS = [
  { id: 'beginner', tier: 'beginner', name: 'Beginner', entryFee: 0, reward: 100, durationHours: 24, axieId: 'kotaro', banner: '/banners/beginner.jpg' },
  { id: 'pro', tier: 'pro', name: 'Pro', entryFee: 5, reward: 1000, durationHours: 24, axieId: 'tripp', banner: '/banners/pro.jpg' },
  { id: 'expert', tier: 'expert', name: 'Expert', entryFee: 20, reward: 1000, durationHours: 24, axieId: 'xia', banner: '/banners/expert.jpg' },
];
function getPool(id) { return CHALLENGE_POOLS.find((p) => p.id === id); }

// You can be enrolled in several pools at once — joining Pro no longer
// blocks Beginner or Expert. Each pool tracks its own window and its own
// distance total; one logged walk/run counts toward all of them at once
// (see the Object.values loop in stopSession above).
function enterChallenge(poolId) {
  const pool = getPool(poolId);
  if (!pool) return;
  if (state.challenges.active[poolId]) { showToast(`Already in the ${pool.name} challenge`); return; }
  if (state.totalBaxs < pool.entryFee) { showToast(`You need ${pool.entryFee} $bAXS to enter`); return; }
  if (pool.entryFee > 0) state.totalBaxs -= pool.entryFee;
  const now = Date.now();
  state.challenges.active[poolId] = { poolId, enteredAt: now, endsAt: now + pool.durationHours * 3600 * 1000, distanceKm: 0 };
  persistState();
  render();
  renderChallengeTab();
  showToast(`Entered the ${pool.name} challenge`);
}

// Pays out (or closes out) every pool whose window has passed — checked on
// app load (in case the app was closed through the whole window) and once
// a second while the Challenge tab is open. Each pool settles independently
// now that more than one can be active at a time.
function settleChallengesIfDue() {
  const active = state.challenges.active;
  let changed = false;
  for (const poolId of Object.keys(active)) {
    const entry = active[poolId];
    if (Date.now() < entry.endsAt) continue;
    const pool = getPool(poolId);
    const won = entry.distanceKm > 0;
    const finished = {
      poolId,
      poolName: pool ? pool.name : poolId,
      endedAt: entry.endsAt,
      distanceKm: entry.distanceKm,
      won,
      reward: won && pool ? pool.reward : 0,
    };
    if (finished.reward > 0) state.totalBaxs += finished.reward;
    state.challenges.history.unshift(finished);
    delete active[poolId];
    changed = true;
    showToast(won ? `${finished.poolName} challenge complete — +${finished.reward} $bAXS` : `${finished.poolName} challenge ended — no activity logged`);
  }
  if (changed) { persistState(); render(); }
}

function fmtCountdown(msRemaining) {
  const s = Math.max(0, Math.floor(msRemaining / 1000));
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(Math.floor(s % 60)).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

// One card per pool you've joined — click a card to drill into that pool's
// full stats + leaderboard (see openChallengeDetail below). Each card is
// banner-styled with the same art as its pennant in Challenge pools.
function renderActivePoolsSection() {
  const wrap = document.getElementById('challenge-active-section');
  const active = state.challenges.active;
  const poolIds = Object.keys(active);
  if (!poolIds.length) { wrap.innerHTML = ''; return; }
  const cards = poolIds.map((poolId) => {
    const entry = active[poolId];
    const pool = getPool(poolId);
    if (!pool) return '';
    return `
      <button type="button" class="active-pool-card" data-pool="${pool.id}" style="background-image:linear-gradient(180deg, rgba(10,10,12,0.1) 30%, rgba(10,10,12,0.88)), url('${pool.banner}')">
        <div class="active-pool-top">
          <span class="tier-badge tier-${pool.tier}">${pool.tier}</span>
          <span class="active-pool-countdown">${fmtCountdown(entry.endsAt - Date.now())}</span>
        </div>
        <div class="active-pool-bottom">
          <div class="active-pool-name">${pool.name} challenge</div>
          <div class="active-pool-row">
            <div><div class="val">${entry.distanceKm.toFixed(2)}</div><div class="lbl">KM logged</div></div>
            <div><div class="val">${pool.reward}</div><div class="lbl">$bAXS reward</div></div>
          </div>
        </div>
      </button>`;
  }).join('');
  wrap.innerHTML = `<div class="section-title">Active pools</div><div class="active-pools-row">${cards}</div>`;
  wrap.querySelectorAll('.active-pool-card').forEach((card) => {
    card.addEventListener('click', () => openChallengeDetail(card.dataset.pool));
  });
}

// Challenge pools stay put at all times (per pool: Beginner/Pro/Expert) —
// entering one no longer disables the other two, so "blocked" is gone;
// a pool's own button only disables once you've already joined THAT pool.
function renderChallengePools() {
  const wrap = document.getElementById('challenge-pools');
  wrap.innerHTML = '';
  const active = state.challenges.active;
  for (const pool of CHALLENGE_POOLS) {
    const isActive = !!active[pool.id];
    const card = document.createElement('div');
    card.className = 'challenge-pool-card';
    card.dataset.tier = pool.tier;
    card.innerHTML = `
      <div class="pennant-flag" style="background-image:linear-gradient(180deg, rgba(10,10,12,0.12), rgba(10,10,12,0.8) 92%), url('${pool.banner}')">
        <div class="pennant-tier">${pool.tier}</div>
        <div class="pennant-name">${pool.name}</div>
        <div class="pennant-fee">${pool.entryFee > 0 ? pool.entryFee + ' $bAXS' : 'Free'}</div>
      </div>
      <div class="pennant-badge">
        <img src="${portraitPath(pool.axieId)}" alt="" />
        <div class="pennant-badge-reward">${pool.reward}</div>
      </div>
      <div class="pennant-footer">
        <div class="pennant-sub">24h &middot; ${pool.reward} $bAXS</div>
        <button class="challenge-enter-btn" type="button" ${isActive ? 'disabled' : ''}>${isActive ? 'Active' : 'Enter'}</button>
      </div>`;
    card.querySelector('.challenge-enter-btn').addEventListener('click', () => enterChallenge(pool.id));
    wrap.appendChild(card);
  }
}

function renderChallengeHistory() {
  const list = document.getElementById('challenge-history');
  const empty = document.getElementById('challenge-history-empty');
  list.innerHTML = '';
  if (!state.challenges.history.length) { empty.hidden = false; return; }
  empty.hidden = true;
  for (const h of state.challenges.history) {
    const row = document.createElement('div');
    row.className = 'challenge-history-row';
    row.innerHTML = `
      <div class="challenge-history-main">
        <div class="challenge-history-title">${h.poolName}</div>
        <div class="challenge-history-sub">${new Date(h.endedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} &middot; ${h.distanceKm.toFixed(2)} km logged</div>
      </div>
      <div class="challenge-history-reward">+${h.reward}</div>`;
    list.appendChild(row);
  }
}

function renderChallengeTab() {
  settleChallengesIfDue();
  renderChallengePools();
  renderActivePoolsSection();
  renderChallengeHistory();
}

let challengeTickTimer = null;
function startChallengeTicker() {
  stopChallengeTicker();
  challengeTickTimer = setInterval(() => {
    const hadCount = Object.keys(state.challenges.active).length;
    settleChallengesIfDue();
    renderActivePoolsSection();
    if (Object.keys(state.challenges.active).length !== hadCount) { renderChallengePools(); renderChallengeHistory(); }
    if (challengeDetailOverlay.dataset.open === 'true') refreshChallengeDetailStats();
  }, 1000);
}
function stopChallengeTicker() { if (challengeTickTimer) { clearInterval(challengeTickTimer); challengeTickTimer = null; } }

/* ---------------------------------------------------------------------
   Challenge detail — drills into one pool from its Active pools card:
   your live stats for that pool plus a per-pool leaderboard. Same demo
   -roster approach as the main Leaderboard tab (buildDemoRows/seededRand
   above), reseeded per pool so each pool's board looks like its own crowd.
   --------------------------------------------------------------------- */
const challengeDetailOverlay = document.getElementById('challenge-detail-overlay');
const challengeDetailBanner = document.getElementById('challenge-detail-banner');
let challengeDetailPoolId = null;

const POOL_LB_RANGE = { beginner: [2, 20], pro: [5, 45], expert: [10, 70] };
const POOL_AXIE_OFFSET = { beginner: 0, pro: 2, expert: 4 };

function buildPoolLeaderboardRows(poolId) {
  const [lo, hi] = POOL_LB_RANGE[poolId] || [2, 30];
  const offset = POOL_AXIE_OFFSET[poolId] || 0;
  return DEMO_TRAINER_NAMES.map((name, i) => {
    const rand = seededRand(`pool:${poolId}:${i}:${name}`);
    const km = lo + rand() * (hi - lo);
    const axie = AXIES[(i + offset) % AXIES.length];
    return { name, km, axieId: axie.id, isYou: false };
  });
}

function renderChallengeDetailLeaderboard(poolId) {
  const listEl = document.getElementById('challenge-detail-leaderboard');
  const rows = buildPoolLeaderboardRows(poolId);
  const entry = state.challenges.active[poolId];
  if (entry) rows.push({ name: 'You', km: entry.distanceKm, axieId: currentAxieId, isYou: true });
  rows.sort((a, b) => b.km - a.km);
  listEl.innerHTML = '';
  rows.forEach((r, i) => {
    const row = document.createElement('div');
    row.className = 'leaderboard-row';
    if (r.isYou) row.dataset.you = 'true';
    row.innerHTML = `
      <div class="leaderboard-rank">${i + 1}</div>
      <img class="leaderboard-avatar" src="${portraitPath(r.axieId)}" alt="" />
      <div class="leaderboard-main"><div class="leaderboard-name">${r.name}</div></div>
      <div class="leaderboard-end"><div class="leaderboard-value">${r.km.toFixed(2)}</div><div class="leaderboard-unit">km</div></div>`;
    listEl.appendChild(row);
  });
  const rankEl = document.getElementById('cd-rank');
  const idx = rows.findIndex((r) => r.isYou);
  rankEl.textContent = idx >= 0 ? `#${idx + 1} of ${rows.length}` : '\u2014';
}

function refreshChallengeDetailStats() {
  if (!challengeDetailPoolId) return;
  const pool = getPool(challengeDetailPoolId);
  const entry = state.challenges.active[challengeDetailPoolId];
  document.getElementById('cd-distance').textContent = (entry ? entry.distanceKm : 0).toFixed(2);
  document.getElementById('cd-reward').textContent = pool ? pool.reward : 0;
  document.getElementById('cd-countdown').textContent = entry ? fmtCountdown(entry.endsAt - Date.now()) : '00:00:00';
}

function openChallengeDetail(poolId) {
  const pool = getPool(poolId);
  if (!pool) return;
  challengeDetailPoolId = poolId;
  const tierEl = document.getElementById('challenge-detail-tier');
  tierEl.textContent = pool.tier;
  tierEl.className = `tier-badge tier-${pool.tier}`;
  document.getElementById('challenge-detail-name').textContent = `${pool.name} challenge`;
  challengeDetailBanner.style.backgroundImage = `linear-gradient(180deg, rgba(10,10,12,0.1) 30%, rgba(10,10,12,0.55) 70%, rgba(10,10,12,0.92)), url('${pool.banner}')`;
  refreshChallengeDetailStats();
  renderChallengeDetailLeaderboard(poolId);
  challengeDetailOverlay.dataset.open = 'true';
}
function closeChallengeDetail() {
  challengeDetailOverlay.dataset.open = 'false';
  challengeDetailPoolId = null;
}
document.getElementById('challenge-detail-back').addEventListener('click', closeChallengeDetail);

/* ---------------------------------------------------------------------
   Share card — captures the REAL map (tiles + your route) since this app
   isn't sandboxed like the Claude artifact. Falls back to a plain drawn
   route (no basemap) if the capture fails for any reason, so sharing never
   breaks even offline or on an odd browser.
   --------------------------------------------------------------------- */
let shareActivityCache = null;

async function captureRouteMapDataURL(points) {
  if (!points || points.length < 1) return null;
  const latLngs = points.map((p) => L.latLng(p[0], p[1]));
  let bounds = L.latLngBounds(latLngs);
  // A very short session (one point, or a few points a couple meters apart)
  // produces a near-zero-area bounds — fitBounds on that zooms in on an
  // arbitrary tiny speck, which reads as "some random place" even though
  // it's technically the right spot. Pad it out to a sensible ~140m box so
  // there's always real map context around your position.
  if (!bounds.isValid() || bounds.getSouthWest().distanceTo(bounds.getNorthEast()) < 40) {
    bounds = latLngs[0].toBounds(140);
  }
  const prevCenter = map.getCenter();
  const prevZoom = map.getZoom();
  // The share card always captures the real Leaflet map, but the player may
  // have Stopped while sitting in 3D World view — #map is `hidden` then, so
  // html2canvas grabs a blank .map-wrap. Force the map view on for the
  // capture and restore whatever view they were actually in afterward.
  const wasWorldView = viewMode === 'world';
  if (wasWorldView) switchToMapView();
  try {
    map.fitBounds(bounds, { padding: [36, 36], maxZoom: 18, animate: false });
    await waitForTilesLoaded(3000);
    await new Promise((r) => setTimeout(r, 200)); // let the paint settle + the 3D overlay reposition
    // .map-wrap, not #map, so the floating 3D Axie (a sibling of #map, not a
    // Leaflet layer) is captured into the share card too.
    const canvas = await html2canvas(document.querySelector('.map-wrap'), {
      useCORS: true,
      backgroundColor: '#131316',
      logging: false,
    });
    return canvas.toDataURL('image/png');
  } catch (e) {
    console.warn('route map capture failed, share card will fall back to a plain route', e);
    return null;
  } finally {
    map.setView(prevCenter, prevZoom, { animate: false });
    if (wasWorldView) await switchToWorldView();
  }
}

function drawFallbackRoute(c, x, y, w, h, points) {
  c.fillStyle = '#131316';
  c.fillRect(x, y, w, h);
  if (!points || !points.length) return;
  if (points.length === 1) {
    // Too short a session for a path — still show a glowing dot rather than
    // a blank rectangle, so a share never looks broken/random.
    c.save();
    c.shadowColor = '#ff9d2e';
    c.shadowBlur = 22;
    c.fillStyle = '#ff9d2e';
    c.beginPath();
    c.arc(x + w / 2, y + h / 2, 9, 0, Math.PI * 2);
    c.fill();
    c.restore();
    return;
  }
  const lats = points.map((p) => p[0]), lngs = points.map((p) => p[1]);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  const midLat = (minLat + maxLat) / 2;
  const mPerDegLat = 110540, mPerDegLng = 111320 * Math.cos(midLat * Math.PI / 180);
  const xs = points.map((p) => (p[1] - minLng) * mPerDegLng);
  const ys = points.map((p) => (p[0] - minLat) * mPerDegLat);
  const spanX = Math.max(1, Math.max(...xs) - Math.min(...xs));
  const spanY = Math.max(1, Math.max(...ys) - Math.min(...ys));
  const pad = 40;
  const scale = Math.min((w - pad * 2) / spanX, (h - pad * 2) / spanY);
  const offX = x + (w - spanX * scale) / 2 - Math.min(...xs) * scale;
  const offY = y + (h - spanY * scale) / 2 + Math.max(...ys) * scale;
  c.strokeStyle = '#ff9d2e';
  c.lineWidth = 7;
  c.lineJoin = 'round';
  c.lineCap = 'round';
  c.shadowColor = '#ff9d2e';
  c.shadowBlur = 18;
  c.beginPath();
  points.forEach((p, i) => {
    const px = offX + xs[i] * scale;
    const py = offY - ys[i] * scale;
    if (i === 0) c.moveTo(px, py); else c.lineTo(px, py);
  });
  c.stroke();
  c.shadowBlur = 0;
}

async function drawShareCard(canvas, activity) {
  try {
    await document.fonts.load('800 60px "Baloo 2"');
    await document.fonts.load('700 30px "Manrope"');
    await document.fonts.load('700 30px "JetBrains Mono"');
  } catch (e) { /* best-effort */ }

  const W = canvas.width, H = canvas.height;
  const c = canvas.getContext('2d');
  c.clearRect(0, 0, W, H);
  c.fillStyle = '#0a0a0c';
  c.fillRect(0, 0, W, H);

  // route map panel — the real captured basemap + orange path when available
  const mapX = 0, mapY = 0, mapW = W, mapH = Math.round(H * 0.46);
  const mapDataUrl = await captureRouteMapDataURL(activity.points);
  if (mapDataUrl) {
    const img = await new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = reject;
      im.src = mapDataUrl;
    }).catch(() => null);
    if (img) {
      // cover-fit the captured square-ish map image into the wide panel
      const srcRatio = img.width / img.height, dstRatio = mapW / mapH;
      let sx = 0, sy = 0, sw = img.width, sh = img.height;
      if (srcRatio > dstRatio) { sw = img.height * dstRatio; sx = (img.width - sw) / 2; }
      else { sh = img.width / dstRatio; sy = (img.height - sh) / 2; }
      c.drawImage(img, sx, sy, sw, sh, mapX, mapY, mapW, mapH);
    } else {
      drawFallbackRoute(c, mapX, mapY, mapW, mapH, activity.points);
    }
  } else {
    drawFallbackRoute(c, mapX, mapY, mapW, mapH, activity.points);
  }
  // fade the map into the card background at the bottom edge
  const fade = c.createLinearGradient(0, mapY + mapH - 140, 0, mapY + mapH);
  fade.addColorStop(0, 'rgba(10,10,12,0)');
  fade.addColorStop(1, 'rgba(10,10,12,1)');
  c.fillStyle = fade;
  c.fillRect(mapX, mapY + mapH - 140, mapW, 140);

  // header wordmark, overlaid on the map panel
  c.textAlign = 'left'; c.textBaseline = 'alphabetic';
  c.font = '800 40px "Baloo 2", sans-serif';
  c.fillStyle = '#ff9d2e';
  c.shadowColor = 'rgba(0,0,0,0.6)'; c.shadowBlur = 14;
  c.fillText('AXIE GO', 56, 88);
  c.font = '700 22px "Manrope", sans-serif';
  c.fillStyle = '#f5f5f7';
  c.textAlign = 'right';
  c.fillText(new Date(activity.startedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }), W - 56, 88);
  c.shadowBlur = 0;

  // type badge overlaid bottom-left of the map panel
  c.textAlign = 'left';
  c.font = '800 28px "Manrope", sans-serif';
  c.fillStyle = activity.type === 'run' ? '#ff9d2e' : '#6be3a6';
  c.fillText((activity.type === 'run' ? 'RUN' : 'WALK') + ' · ' + timeLabel(activity.startedAt), 56, mapY + mapH - 24);

  // Big 2x2 stat grid — Steps / KM / Time / $bAXS, all equally emphasized
  // (no headline-vs-secondary split, and no Pace — GPS-derived pace on a
  // phone isn't reliable enough to headline, so it's dropped entirely).
  const cx = W / 2;
  const gridTop = mapY + mapH + 26;
  const gridBottom = H - 116;
  const gridH = gridBottom - gridTop;
  const rowH = gridH / 2;
  const colW = W / 2;

  const cells = [
    { label: 'KILOMETERS', value: activity.distanceKm.toFixed(2), accent: false },
    { label: 'STEPS', value: Math.round(activity.steps).toLocaleString(), accent: false },
    { label: 'TIME', value: fmtTime(activity.durationSec), accent: false },
    { label: '$BAXS EARNED', value: '+' + activity.baxs.toFixed(3), accent: true },
  ];
  c.textAlign = 'center';
  cells.forEach((cell, i) => {
    const col = i % 2, row = Math.floor(i / 2);
    const x = colW * col + colW / 2;
    const y = gridTop + rowH * row + rowH / 2;
    c.font = '800 76px "Baloo 2", sans-serif';
    c.fillStyle = cell.accent ? '#ff9d2e' : '#f5f5f7';
    c.fillText(cell.value, x, y + 4);
    c.font = '700 22px "Manrope", sans-serif';
    c.fillStyle = '#8b8b93';
    c.fillText(cell.label, x, y + 40);
  });
  // faint divider between the four cells
  c.strokeStyle = 'rgba(255,255,255,0.06)';
  c.lineWidth = 1;
  c.beginPath(); c.moveTo(cx, gridTop + 10); c.lineTo(cx, gridBottom - 10); c.stroke();
  c.beginPath(); c.moveTo(56, gridTop + rowH); c.lineTo(W - 56, gridTop + rowH); c.stroke();

  // divider + footer
  c.strokeStyle = 'rgba(255,255,255,0.08)';
  c.lineWidth = 1;
  c.beginPath(); c.moveTo(56, H - 100); c.lineTo(W - 56, H - 100); c.stroke();
  c.font = '700 22px "Manrope", sans-serif';
  c.fillStyle = '#59595f';
  c.textAlign = 'center';
  c.fillText('Walk it. Run it. Earn it.', cx, H - 56);
}

function offerShare(activity) {
  shareActivityCache = activity;
  const overlay = document.getElementById('share-overlay');
  const canvas = document.getElementById('share-canvas');
  overlay.dataset.open = 'true';
  drawShareCard(canvas, activity);
}
function closeShare() { document.getElementById('share-overlay').dataset.open = 'false'; }

document.getElementById('share-close-btn').addEventListener('click', closeShare);
document.getElementById('share-save-btn').addEventListener('click', async () => {
  const canvas = document.getElementById('share-canvas');
  const activity = shareActivityCache;
  const filename = `axie-go-${activity ? activity.type : 'activity'}-${Date.now()}.png`;

  canvas.toBlob(async (blob) => {
    if (!blob) {
      showToast('Could not generate the share image');
      return;
    }
    const file = new File([blob], filename, { type: 'image/png' });
    // Real browser, real Web Share API — an actual OS share sheet (every
    // sharing app the phone has registered), not a fake "save image"
    // workaround like the sandboxed artifact needs.
    //
    // navigator.share/canShare only exist at all in a "secure context" —
    // HTTPS, or localhost. Opening this app at http://<lan-ip>:5173 on a
    // phone (the normal way to test it) is NOT a secure context, so on
    // plenty of phones this silently falls through to the plain download
    // below with no share sheet at all — not a bug in this logic, a
    // browser platform restriction. `npm run dev` now serves over HTTPS
    // (see vite.config.js) specifically so this works for real.
    if (navigator.share) {
      try {
        if (!navigator.canShare || navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file], title: 'Axie GO', text: 'Walk it. Run it. Earn it.' });
          return;
        }
      } catch (e) {
        if (e && e.name === 'AbortError') return; // user dismissed the share sheet
        console.warn('share failed, falling back to download', e);
      }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    showToast(window.isSecureContext ? 'Image downloaded' : 'Downloaded — open over HTTPS for the share sheet');
  }, 'image/png');
});

/* ---------------------------------------------------------------------
   Splash
   --------------------------------------------------------------------- */
const PERMISSIONS_ONBOARDED_KEY = 'axie-go-permissions-onboarded-v1';

el.splashCta.addEventListener('click', () => {
  el.splash.dataset.leaving = 'true';
  centerOnRealLocationOnce();
  setTimeout(() => { el.splash.remove(); map.invalidateSize(); positionOverlay(); }, 550);

  // First-ever open: ask for everything the app can use up front (Location,
  // Notifications + Physical Activity, Health Connect) instead of only
  // discovering Location when GO is first pressed and the rest even later
  // than that. Gated so it only runs once per install, not every launch.
  let alreadyOnboarded = true;
  try { alreadyOnboarded = !!localStorage.getItem(PERMISSIONS_ONBOARDED_KEY); } catch (e) { /* ignore */ }
  if (!alreadyOnboarded) {
    requestAllCorePermissions().finally(() => {
      try { localStorage.setItem(PERMISSIONS_ONBOARDED_KEY, '1'); } catch (e) { /* ignore */ }
    });
  }
});

/* ---------------------------------------------------------------------
   Background step counter (native Android only — see src/stepCounter.js)
   --------------------------------------------------------------------- */
const bgEl = {
  card: document.getElementById('bg-steps-card'),
  value: document.getElementById('bg-steps-value'),
  toggle: document.getElementById('bg-steps-toggle'),
  hcWrap: document.getElementById('bg-steps-hc'),
  hcLabel: document.getElementById('bg-steps-hc-label'),
  hcBtn: document.getElementById('bg-steps-hc-btn'),
};
let bgTracking = false;

async function refreshBgSteps() {
  try {
    const res = await StepCounter.getTodaySteps();
    bgEl.value.textContent = (res.steps || 0).toLocaleString();
    bgTracking = !!res.tracking;
    bgEl.toggle.textContent = bgTracking ? 'Turn off' : 'Turn on';
    bgEl.toggle.dataset.on = String(bgTracking);
  } catch (e) {
    // native plugin unavailable (web preview) — leave the zeroed defaults
  }
}

async function toggleBgTracking() {
  if (!isNative) { showToast('Background tracking needs the installed Android app'); return; }
  if (bgTracking) {
    await StepCounter.stop();
    bgTracking = false;
    bgEl.toggle.textContent = 'Turn on';
    bgEl.toggle.dataset.on = 'false';
    showToast('Background step tracking turned off');
    return;
  }
  const supported = await StepCounter.isSupported();
  if (!supported.supported) { showToast("This phone doesn't report a hardware step sensor"); return; }
  const perms = await StepCounter.requestPermissions();
  if (perms.activity !== 'granted') { showToast('Physical activity permission is required for step counting'); return; }
  await StepCounter.start();
  bgTracking = true;
  bgEl.toggle.textContent = 'Turn off';
  bgEl.toggle.dataset.on = 'true';
  showToast('Background tracking is on — check your notification shade');
  refreshBgSteps();
}

bgEl.toggle?.addEventListener('click', () => {
  toggleBgTracking().catch((e) => showToast(e.message || 'Could not change background tracking'));
});

async function refreshHealthConnect() {
  try {
    const avail = await StepCounter.isHealthConnectAvailable();
    if (!avail.available) { bgEl.hcWrap.hidden = true; return; }
    bgEl.hcWrap.hidden = false;
    const hc = await StepCounter.getHealthConnectTodaySteps();
    bgEl.hcLabel.textContent = hc.steps == null
      ? 'Health Connect: tap to sync'
      : `Health Connect total today: ${Number(hc.steps).toLocaleString()} steps (all synced apps)`;
  } catch (e) {
    bgEl.hcWrap.hidden = true;
  }
}

bgEl.hcBtn?.addEventListener('click', async () => {
  try {
    const res = await StepCounter.requestHealthConnectPermissions();
    // Health Connect's own consent screen lets you grant Read and Write
    // independently — treat Read alone as a real, useful connection (it's
    // all the app's own "sync in" / backfill features need) instead of
    // reporting total failure just because Write was declined.
    if (res.granted) {
      showToast('Synced with Health Connect');
    } else if (res.grantedRead) {
      showToast('Health Connect connected (read-only) — steps sync in, not out');
    } else {
      // TEMP diagnostic suffix — the native side now reports exactly what
      // it saw (result code from the consent screen, and how many
      // permissions the parsed result vs. a live re-check found granted).
      // Safe to ignore functionally; remove once Health Connect is
      // confirmed working, it's only here to see what's happening without
      // needing device logs.
      const diag = (res.resultCode != null)
        ? ` [code:${res.resultCode} parsed:${res.parsedCount} live:${res.liveCount}]`
        : '';
      showToast('Health Connect permission was not granted' + diag);
    }
    refreshHealthConnect();
  } catch (e) {
    showToast(e.message || 'Health Connect is not installed on this phone');
  }
});

StepCounter.addListener('stepsUpdated', (data) => {
  if (currentTab === 'activity') bgEl.value.textContent = (data.steps || 0).toLocaleString();
});

if (isNative) {
  refreshBgSteps();
  refreshHealthConnect();
  setInterval(refreshBgSteps, 30000);
}

settleChallengesIfDue(); // pay out/close any challenge whose 24h window passed while the app was closed
setControlState('idle');
render();
switchTab('track');
