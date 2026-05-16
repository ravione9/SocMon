import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  // Docker service name only works inside compose; local `npm run dev` needs localhost.
  const apiProxyTarget = env.VITE_DEV_PROXY_TARGET || 'http://127.0.0.1:5000'

  return {
    plugins: [react()],
    resolve: { alias: { '@': path.resolve(__dirname, './src') } },
    build: {
      // 600KB warn line is more useful than the default 500 for a feature-rich app
      // — keeps the warning meaningful without turning into noise from chart.js etc.
      chunkSizeWarningLimit: 600,
      rollupOptions: {
        output: {
          /**
           * Split heavy/optional dependencies into their own chunks so:
           *  - The Login page and lightweight pages never download big bundles like
           *    Chart.js, xterm, or socket.io — measurable TTI win on slower machines.
           *  - The browser caches each chunk independently — a Chart.js patch release
           *    won't bust the rest of the bundle's cache.
           */
          manualChunks(id) {
            if (!id.includes('node_modules')) return
            if (id.includes('chart.js') || id.includes('react-chartjs-2')) return 'chart'
            if (id.includes('@xterm')) return 'xterm'
            if (id.includes('socket.io-client')) return 'socketio'
            if (id.includes('react-router')) return 'router'
            if (id.includes('date-fns')) return 'date'
            if (id.includes('axios')) return 'axios'
            if (id.includes('react-hot-toast')) return 'toast'
            // React + scheduler shouldn't be split out in a way that breaks the
            // shared instance contract; leave them in the default vendor chunk.
            return undefined
          },
        },
      },
    },
    server: {
      host: '0.0.0.0',
      port: 3000,
      proxy: {
        '/api': { target: apiProxyTarget, changeOrigin: true },
        '/socket.io': { target: apiProxyTarget, ws: true },
      },
    },
  }
})
