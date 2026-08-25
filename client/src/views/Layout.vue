<script lang="ts" setup>
import SessionList from '@/components/SessionList.vue';
import { onMounted } from 'vue';
import { useChatStore } from '@/stores/chat';

const chat = useChatStore()

onMounted(() => {
    chat.initSessions()
})
</script>
<template>
    <div class="app-layout">
        <SessionList></SessionList>
        <div class="main-area"><router-view /></div>
    </div>
</template>