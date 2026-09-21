import { registerPlugin, Capacitor } from '@capacitor/core';

/* =============================================================================
   Bridge to the native StepCounter plugin (android/.../StepCounterPlugin.kt).
   Reads the phone's own hardware step-counter sensor via a foreground
   service + persistent notification, so it keeps counting even with the app
   closed. There is no web implementation of the real thing — a browser tab
   cannot run a foreground service or a native notification — so the web
   fallback below just reports "not supported" instead of pretending to
   count anything, matching this app's existing rule of never faking a
   capability the current runtime doesn't actually have.
   ============================================================================= */

export const isNative = Capacitor.isNativePlatform();

export const StepCounter = registerPlugin('StepCounter', {
  web: () => ({
    async isSupported() { return { supported: false }; },
    async checkPermissions() { return { activity: 'denied', notifications: 'denied' }; },
    async requestPermissions() { return { activity: 'denied', notifications: 'denied' }; },
    async start() { throw new Error('Background step tracking needs the installed Android app.'); },
    async stop() {},
    async getTodaySteps() { return { steps: 0, distanceKm: 0, tracking: false }; },
    async isHealthConnectAvailable() { return { available: false }; },
    async requestHealthConnectPermissions() { throw new Error('Health Connect needs the installed Android app.'); },
    async getHealthConnectTodaySteps() { return {}; },
    addListener() { return Promise.resolve({ remove() {} }); },
  }),
});
