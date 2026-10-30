import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import postcssRTLCSS from 'postcss-rtlcss'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  css: {
    postcss: {
      // Adds mirrored [dir="rtl"] rules (for Arabic) next to the original ones. With
      // safeBothPrefix every direction-dependent declaration gets the same [dir] prefix,
      // so later (e.g. mobile) rules still win in both directions. <html> always carries
      // a dir attribute (index.html, I18nProvider).
      plugins: [postcssRTLCSS({ mode: 'override', safeBothPrefix: true })],
    },
  },
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: 'three-core', test: /node_modules[\\/]three[\\/]/, maxSize: 420_000, priority: 10 },
            { name: 'fiber-runtime', test: /node_modules[\\/]@react-three[\\/]fiber[\\/]/, maxSize: 420_000, priority: 8 },
            { name: 'drei-helpers', test: /node_modules[\\/]@react-three[\\/]drei[\\/]/, maxSize: 420_000, priority: 8 },
          ],
        },
      },
    },
  },
})
