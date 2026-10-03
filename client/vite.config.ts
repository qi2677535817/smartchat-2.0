import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import vueDevTools from 'vite-plugin-vue-devtools'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    vue(),
    vueDevTools(),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    // 允许局域网访问开发服务（配合下方 proxy，任意访问地址都能正常请求后端）
    host: true,
    proxy: {
      // 前端统一请求 /api/xxx，由此处剥离前缀并转发到后端 3000
      // 浏览器只与同源通信，彻底规避跨域与 Private Network Access 拦截
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
})
