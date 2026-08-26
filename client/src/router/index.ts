import ChatView from '@/views/ChatView.vue'
import Layout from '@/views/Layout.vue'
import KnowledgeView from '@/views/KnowledgeView.vue'
import { createRouter, createWebHistory } from 'vue-router'

const routes: any[] = [
  {
    path:'/',
    component: Layout,
    children:[
      {
        path:'',
        redirect:'/chat'
      },
      {
        path:'chat/:id?',
        name:'chat',
        component: ChatView
      },
      {
        path:'/knowledge',
        name:'knowledge',
        component: KnowledgeView
      }
    ]
  }
]

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: routes,
})

export default router
