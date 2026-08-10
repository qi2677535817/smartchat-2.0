import { marked } from 'marked'
import DOMPurify from 'dompurify'

export function renderMarkdown(text: string): string {
    // marked 把 markdown 转换为 HTML 字符串
    const html = marked.parse(text) as string
    // DOMPurify 把 HTML 字符串转换为安全的 HTML 字符串
    return DOMPurify.sanitize(html)
}