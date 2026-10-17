import { defineConfig } from 'vite';

// Desktop: http://localhost:5173 (browsers treat localhost as a secure context, so the camera works).
export default defineConfig({ server: { port: 5173 } });
