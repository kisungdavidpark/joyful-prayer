import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'fs'

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'))
const isCapacitor = process.env.BUILD_TARGET === 'capacitor'
const isDev = process.env.NODE_ENV === 'development'

export default defineConfig({
  base: isDev ? '/' : isCapacitor ? './' : '/joyful-prayer/',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_DATE__: JSON.stringify(new Date().toISOString().slice(0, 10)),
  },
  plugins: [react()],
})
