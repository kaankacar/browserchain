/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

const page = (name: string) => fileURLToPath(new URL(name, import.meta.url));

export default defineConfig({
  // GitHub Pages serves the site under /<repo>/; the deploy workflow sets BASE_PATH.
  base: process.env.BASE_PATH || '/',
  plugins: [react(), tailwindcss()],
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: { input: { app: page('./index.html'), howItWorks: page('./how-it-works.html') } },
  },
  server: { port: 5173, strictPort: false },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // The simulations run on a virtual clock, so only wall time can fail them.
    // Half the cores and a long timeout keep the heavy seed sweeps reliable.
    maxWorkers: '50%',
    testTimeout: 240_000,
  },
});
