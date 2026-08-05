import { createRouter, createWebHistory } from 'vue-router'

const routes: any[] = [
  {
    name: 'chat',
    path: '/',
    component: () => import('../views/ChatView.vue'),
  },
]

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: routes,
})

export default router
