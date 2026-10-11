
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],

  optimizeDeps: {
    include: ['mersenne-twister'],
  },

  define: {
    CESIUM_BASE_URL: JSON.stringify('/cesium/'),
  },

  server: {
    proxy: {
      '/api/celestrak': {
        target: 'https://celestrak.org',
        changeOrigin: true,
        secure: true,
        rewrite: (path) =>
          path.replace(
            /^\/api\/celestrak/,
            '/NORAD/elements/gp.php'
          ),
      },
    },
  },
})
