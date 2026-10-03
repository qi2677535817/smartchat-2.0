import { Column, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

// 会话附件表：对话内上传的 PDF 解析结果，与全局 RAG 库严格隔离
@Entity('session_attachments')
export class SessionAttachment {
    @PrimaryGeneratedColumn('uuid')
    id!: string

    // 归属会话
    @Index()
    @Column()
    sessionId!: string

    // 原始文件名
    @Column()
    filename!: string

    // 解析后的纯文本全文（展示/降级用）
    @Column({ type: 'text' })
    text!: string

    // 分块与向量（JSON 字符串：[{ text, vector:number[] }]）
    @Column({ type: 'text' })
    chunks!: string

    // 创建时间（毫秒时间戳）
    @Column()
    createdAt!: number
}
