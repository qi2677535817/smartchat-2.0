<script lang="ts" setup>
/**
 * 侧边栏：品牌区 + 主导航 + 会话列表
 * 深色底 + 品牌蓝强调，hover/激活态统一
 */
import { useChatStore } from '@/stores/chat';
import { useRoute, useRouter } from 'vue-router';
import AppIcon from '@/components/AppIcon.vue';

const chat = useChatStore()
const router = useRouter()
const route = useRoute()

const toRag = () => router.push('/knowledge')
// 当前路由高亮：知识库页激活该导航项
const isRagActive = () => route.path.startsWith('/knowledge')

// 会话操作后跳回对话页：store 只切换数据，需配合路由跳转，
// 否则在知识库页点击会话/新建对话时数据变了但页面仍停留在原路由
const goChat = () => {
    if (!route.path.startsWith('/chat')) router.push('/chat')
}
const newChat = async () => {
    await chat.createSession()
    goChat()
}
const openSession = async (id: string) => {
    await chat.switchSession(id)
    goChat()
}
</script>

<template>
    <aside class="sidebar">
        <!-- 品牌区 -->
        <div class="sidebar__brand">
            <span class="sidebar__logo"><AppIcon name="sparkle" :size="18" /></span>
            <div class="sidebar__brand-text">
                <strong>SmartChat</strong>
                <span>企业知识助手</span>
            </div>
        </div>

        <!-- 主操作 -->
        <button class="new-chat" @click="newChat">
            <AppIcon name="plus" :size="16" />
            <span>新建对话</span>
        </button>

        <!-- 导航 -->
        <nav class="sidebar__nav">
            <button class="nav-item" :class="{ 'nav-item--active': isRagActive() }" @click="toRag">
                <AppIcon name="book" :size="16" />
                <span>RAG 知识库</span>
            </button>
        </nav>

        <div class="sidebar__divider" />

        <!-- 会话列表 -->
        <div class="sidebar__label">
            <span>最近对话</span>
            <span class="badge">{{ chat.sessions.length }}</span>
        </div>
        <div class="session-list">
            <div v-for="item in chat.sessions" :key="item.id"
                :class="['session-item', chat.activeId === item.id ? 'session-item--active' : '']"
                @click="openSession(item.id)">
                <AppIcon name="chat" :size="15" class="session-item__icon" />
                <span class="session-item__title">{{ item.title || '新对话' }}</span>
                <button class="session-item__del" title="删除对话" aria-label="删除对话"
                    @click.stop="chat.deleteSession(item.id)">
                    <AppIcon name="trash" :size="14" />
                </button>
            </div>
            <div v-if="!chat.sessions.length" class="session-list__empty">暂无对话</div>
        </div>
    </aside>
</template>

<style lang="scss" scoped>
.sidebar {
    display: flex;
    flex-direction: column;
    width: var(--sidebar-w);
    height: 100vh;
    padding: var(--sp-4) var(--sp-3);
    box-sizing: border-box;
    color: var(--ink-300);
    background: var(--ink-900);
    border-right: 1px solid var(--ink-800);
    overflow: hidden;

    /* 品牌区 */
    .sidebar__brand {
        display: flex;
        align-items: center;
        gap: var(--sp-3);
        padding: var(--sp-2) var(--sp-2) var(--sp-4);
    }

    .sidebar__logo {
        display: grid;
        place-items: center;
        width: 34px;
        height: 34px;
        color: var(--white);
        background: linear-gradient(135deg, var(--brand-500), var(--brand-700));
        border-radius: var(--r-md);
        box-shadow: var(--shadow-sm);
    }

    .sidebar__brand-text {
        display: flex;
        flex-direction: column;
        line-height: 1.25;

        strong {
            font-size: 15px;
            color: var(--white);
            letter-spacing: .01em;
        }

        span {
            font-size: 11.5px;
            color: var(--ink-400);
        }
    }

    /* 新建对话 */
    .new-chat {
        display: flex;
        align-items: center;
        gap: var(--sp-2);
        padding: 10px var(--sp-3);
        font-family: inherit;
        font-size: 14px;
        font-weight: 500;
        color: var(--white);
        background: var(--brand-600);
        border: none;
        border-radius: var(--r-sm);
        cursor: pointer;
        transition: background .16s ease, transform .16s ease;

        &:hover {
            background: var(--brand-500);
        }

        &:active {
            transform: translateY(1px);
        }
    }

    /* 导航 */
    .sidebar__nav {
        margin-top: var(--sp-3);
    }

    .nav-item {
        display: flex;
        align-items: center;
        gap: var(--sp-2);
        width: 100%;
        padding: 9px var(--sp-3);
        font-family: inherit;
        font-size: 14px;
        text-align: left;
        color: var(--ink-300);
        background: transparent;
        border: none;
        border-radius: var(--r-sm);
        cursor: pointer;
        transition: background .16s ease, color .16s ease;

        &:hover {
            color: var(--white);
            background: var(--ink-800);
        }

        &--active {
            color: var(--white);
            background: var(--ink-800);
            box-shadow: inset 2px 0 0 var(--brand-500);
        }
    }

    .sidebar__divider {
        height: 1px;
        margin: var(--sp-4) var(--sp-2);
        background: var(--ink-800);
    }

    /* 会话列表 */
    .sidebar__label {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 0 var(--sp-2) var(--sp-2);
        font-size: 11.5px;
        font-weight: 600;
        letter-spacing: .06em;
        text-transform: uppercase;
        color: var(--ink-500);
    }

    .session-list {
        flex: 1;
        overflow-y: auto;
        display: flex;
        flex-direction: column;
        gap: 2px;
    }

    .session-item {
        display: flex;
        align-items: center;
        gap: var(--sp-2);
        padding: 9px var(--sp-2) 9px var(--sp-3);
        border-radius: var(--r-sm);
        cursor: pointer;
        color: var(--ink-300);
        transition: background .16s ease, color .16s ease;

        &:hover {
            background: var(--ink-800);
            color: var(--white);

            .session-item__del {
                opacity: 1;
            }
        }

        &--active {
            background: var(--ink-800);
            color: var(--white);
            font-weight: 500;
        }
    }

    .session-item__icon {
        color: var(--ink-500);
    }

    .session-item--active .session-item__icon {
        color: var(--brand-500);
    }

    .session-item__title {
        flex: 1;
        min-width: 0;
        font-size: 13.5px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }

    .session-item__del {
        display: grid;
        place-items: center;
        padding: 4px;
        color: var(--ink-400);
        background: transparent;
        border: none;
        border-radius: var(--r-xs);
        cursor: pointer;
        opacity: 0;
        transition: opacity .16s ease, color .16s ease, background .16s ease;

        &:hover {
            color: var(--danger);
            background: var(--ink-700);
        }
    }

    .session-list__empty {
        padding: var(--sp-4) var(--sp-3);
        font-size: 13px;
        color: var(--ink-500);
        text-align: center;
    }
}
</style>
