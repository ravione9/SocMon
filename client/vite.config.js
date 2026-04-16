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
      rollupOptions: {
        output: {
          /** Isolate Chart.js (~180k) so non-Sentinel routes skip downloading it. */
          manualChunks(id) {
            if (!id.includes('node_modules')) return
            if (id.includes('chart.js') || id.includes('react-chartjs-2')) return 'chart'
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
