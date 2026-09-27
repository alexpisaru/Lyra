/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// Lyra API stays on 127.0.0.1:8787. In development Vite plays the role Caddy has
// in production: same origin for the page, /api and /ws proxied to the API with
// the original Host header (the API's same-origin check relies on it).
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {}
const API = env.LYRA_API ?? 'http://127.0.0.1:8787'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: false,
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'Lyra',
        short_name: 'Lyra',
        description: 'Assistente personale locale',
        lang: 'it',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'any',
        background_color: '#02040a',
        theme_color: '#02040a',
        icons: [
          { src: 'pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'pwa-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Only the app shell and static assets. Lyra itself never "works" offline.
        globPatterns: ['**/*.{js,css,html,svg,png,webmanifest}'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//, /^\/ws/],
        runtimeCaching: [],
      },
    }),
  ],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': { target: API, changeOrigin: false },
      '/ws': { target: API.replace(/^http/, 'ws'), ws: true, changeOrigin: false },
    },
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
    proxy: {
      '/api': { target: API, changeOrigin: false },
      '/ws': { target: API.replace(/^http/, 'ws'), ws: true, changeOrigin: false },
    },
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 900,
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: false,
  },
})
