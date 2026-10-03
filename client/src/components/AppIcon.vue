<script setup lang="ts">
/**
 * 统一图标组件（内联 SVG，零依赖）
 * 用法：<AppIcon name="send" :size="16" />
 * 全部图标使用 currentColor，随文字颜色变化
 */
const props = withDefaults(defineProps<{ name: string; size?: number }>(), { size: 18 })

// 24x24 网格下的路径数据
const PATHS: Record<string, string[]> = {
    plus: ['M12 5v14', 'M5 12h14'],
    chat: ['M21 11.5a8 8 0 0 1-8 8H7l-4 3.5v-11.5a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8z'],
    book: ['M4 4.5A2.5 2.5 0 0 1 6.5 2H20v17H6.5A2.5 2.5 0 0 0 4 21.5V4.5z', 'M20 19v3H6.5A2.5 2.5 0 0 1 4 19.5'],
    trash: ['M4 7h16', 'M10 11v6', 'M14 11v6', 'M6 7l1 13h10l1-13', 'M9 7V4h6v3'],
    send: ['M4.5 12.5L20 4l-5.5 15.5-3.5-6.5-6.5-1z'],
    stop: ['M7.5 7.5h9v9h-9z'],
    paperclip: ['M20 11.5l-8.2 8.2a5 5 0 0 1-7.1-7.1l7.7-7.7a3.4 3.4 0 0 1 4.8 4.8l-7.6 7.6a1.8 1.8 0 0 1-2.5-2.5l7-7'],
    chevron: ['M6 9.5l6 6 6-6'],
    sparkle: ['M12 3l1.9 5.4L19.5 10l-5.6 1.6L12 17l-1.9-5.4L4.5 10l5.6-1.6L12 3z', 'M18.5 16.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2z'],
    file: ['M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5z', 'M14 3v5h5', 'M9 13.5h6', 'M9 17.5h4'],
    database: ['M4 6.5c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3z', 'M4 6.5v11c0 1.7 3.6 3 8 3s8-1.3 8-3v-11', 'M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3'],
    alert: ['M12 8.5v4.5', 'M12 16.5v.5', 'M10.4 4.2L2.9 17.5a2 2 0 0 0 1.7 3h14.8a2 2 0 0 0 1.7-3L13.6 4.2a2 2 0 0 0-3.2 0z'],
    check: ['M4.5 12.5l4.5 4.5L19.5 6.5'],
    clock: ['M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16z', 'M12 8v4.5l3 1.8'],
    hash: ['M5 9h14', 'M5 15h14', 'M11 4l-2 16', 'M17 4l-2 16'],
}

const paths = PATHS[props.name] ?? PATHS.sparkle
</script>

<template>
    <svg class="app-icon" :width="size" :height="size" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
        <path v-for="(d, i) in paths" :key="i" :d="d" />
    </svg>
</template>

<style scoped>
.app-icon {
    display: block;
    flex: none;
}
</style>
