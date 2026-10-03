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
        <SessionList />
        <main class="main-area"><router-view /></main>
    </div>
</template>

<style lang="scss">
.app-layout {
    display: flex;
    height: 100vh;
    overflow: hidden;
}

.main-area {
    flex: 1;
    min-width: 0;
    height: 100vh;
    overflow: hidden;
    background: var(--ink-50);
}
</style>
