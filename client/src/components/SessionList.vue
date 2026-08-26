<script lang="ts" setup>
    import { useChatStore } from '@/stores/chat';
    import { useRouter } from 'vue-router';
    
    const chat = useChatStore()
    const router = useRouter()
  
    const toRag = () => {
      router.push('/knowledge')
    }
</script>
<template>
    <div class="chat-management">
        <div class="left-btn" @click="chat.createSession">
            ✏️ 创建新对话 
        </div>
        <div class="left-btn">
            <RouterLink to="/knowledge">📚 RAG知识库</RouterLink> 
        </div>
        <div v-for="(item, index) in chat.sessions" :key="item.id"
            :class="['chat-item', chat.activeId == item.id ? 'chat-item-active' : '']" @click="chat.switchSession(item.id)">
            <div>💬{{ item.title }}</div>
            <div @click.stop="chat.deleteSession(item.id)">♻️</div>
        </div>
    </div>
</template>
<style  lang="scss" scoped>
.chat-management {
  height: 100vh;
  padding: 10px;
  border-right: 1px solid #e7e7e7;
  z-index: 9;
  box-sizing: border-box;
  .left-btn, .chat-item {
    padding: 10px;
    cursor: pointer;
    margin-bottom: 2px;
    &:hover {
      background: #d9d9d9;
      border-radius: 5px;
    }
  }
  .chat-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .chat-item-active {
    background: #a6d0fd;
    border-radius: 5px;
  }
}
</style>
