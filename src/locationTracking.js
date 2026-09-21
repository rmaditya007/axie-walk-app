import { registerPlugin, Capacitor } from '@capacitor/core';

/* =============================================================================
   Bridge to the native LocationTracking plugin
   (android/.../LocationTrackingPlugin.kt + LocationTrackingService.kt).

   Runs the GPS subscription for a GO session inside a real Android
   foreground service — the same pattern src/stepCounter.js already uses for
   steps — instead of a plain navigator.geolocation.watchPosition() call in
   this WebView. That matters because locking the screen pauses/throttles
   WebView JS (no foreground service = the OS eventually treats the app as
   background), so a plain watchPosition()-based tracker silently stops
   accumulating distance/time the moment the phone locks. The native service
   keeps its own foreground-service exemption for location access and its
   own persistent notification, so a session keeps tracking — and keeps
   showing live Walk/Run status in the notification shade — with the screen
   off.

   There is no web implementation of the real thing for the same reason
   stepCounter.js has none: a browser tab can't run a foreground service.
   main.js falls back to its own navigator.geolocation-based tracking
   whenever this reports unsupported (dev preview / non-Android runtimes).
   ============================================================================= */

export const isNative = Capacitor.isNativePlatform();

export const LocationTracking = registerPlugin('LocationTracking', {
  web: () => ({
    async isSupported() { return { supported: false }; },
    async checkPermissions() { return { location: 'denied' }; },
    async requestPermissions() { return { location: 'denied' }; },
    async start() { throw new Error('Background GPS tracking needs the installed Android app.'); },
    async pause() {},
    async resume() {},
    async stop() { return {}; },
    async getSessionSnapshot() { return { active: false }; },
    addListener() { return Promise.resolve({ remove() {} }); },
  }),
});
