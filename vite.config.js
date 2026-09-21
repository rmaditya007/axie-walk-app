import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

/* HTTPS in dev matters here, not just as a nicety: on a real phone browser,
   the Web Share API (the native share sheet) and — on iOS Safari
   specifically — the Geolocation API refuse to run at all on a plain HTTP
   origin (a "secure context" is required, and only localhost/HTTPS count).
   Testing over http://<lan-ip>:5173 can silently break GPS on iOS and always
   breaks the native share sheet everywhere. basicSsl() self-signs a
   dev-only certificate so `npm run dev` serves over https://<lan-ip>:5173 —
   your phone's browser will show a one-time "not secure" warning for the
   self-signed cert (tap Advanced -> Proceed, or Show Details -> visit this
   website on iOS); once you click through, it IS a secure context and both
   APIs work normally. */
export default defineConfig({
  plugins: [basicSsl()],
  server: {
    https: true,
    host: true,
  },
  preview: {
    https: true,
    host: true,
  },
  build: {
    target: 'esnext',
  },
});
