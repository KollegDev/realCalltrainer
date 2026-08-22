import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// Local home-network (Wi-Fi) testing only — NOT exposed to the internet.
// HTTPS (self-signed) is required so the microphone works when the phone
// connects via the PC's LAN IP instead of localhost.
export default defineConfig({
  plugins: [basicSsl()],
  server: {
    port: 5173,
    open: true,   // auto-open the browser on `npm run dev`
    host: true,   // listen on the LAN so other devices on your Wi-Fi can reach it
  },
});
