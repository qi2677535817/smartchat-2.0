import ChatView from '@/views/ChatView.vue'
import Layout from '@/views/Layout.vue'
import { createRouter, createWebHistory } from 'vue-router'

const routes: any[] = [
  {
    path:'/',
    component: Layout,
    children:[
      {
        path:'',
        name:'chat',
        component: ChatView
      }
    ]
  }
]

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: routes,
})

export default router
