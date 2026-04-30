import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const isCapacitor = process.env.BUILD_TARGET === 'capacitor'
const isDev = process.env.NODE_ENV === 'development'

export default defineConfig({
  base: isDev ? '/' : isCapacitor ? './' : '/joyful-prayer/',
  plugins: [react()],
})