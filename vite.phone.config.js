import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// Phone on the same Wi-Fi: phones only allow camera access on https://, so serve a self-signed cert on the LAN.
// Open  https://<your-computer-LAN-IP>:5173  on the phone and accept the certificate warning once.
export default defineConfig({ plugins: [basicSsl()], server: { host: true, port: 5173, https: true } });
