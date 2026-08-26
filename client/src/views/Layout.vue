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
<style lang="scss">
.app-layout {
    display: grid;
    grid-template-columns: 20% 1fr;
}
</style>