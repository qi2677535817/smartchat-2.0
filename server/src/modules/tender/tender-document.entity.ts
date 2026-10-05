import { Column, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

// 招标文件表 —— 字段按 PRD 决策 D3 拍板
// pageCount / pageOffset 允许为空，由阶段 2（FC 提取）填充
// status 起 6 列为「局域网多人加固」新增（见 openspec/changes/harden-lan-multiuser/design.md §2）
@Entity('tender_documents')
export class TenderDocument {
    @PrimaryGeneratedColumn('uuid')
    id!: string

    // 原始文件名
    @Column()
    filename!: string

    // PDF 落盘绝对路径
    @Column()
    path!: string

    // 总页数（阶段 2 填充）；联合类型无法反射推断，显式声明列类型
    @Column({ nullable: true, type: 'integer' })
    pageCount!: number | null

    // 页码校准 offset（阶段 2 填充）
    @Column({ nullable: true, type: 'integer' })
    pageOffset!: number | null

    // 创建时间（毫秒时间戳，与 session 模块惯例一致）
    @Column()
    createdAt!: number

    // ===== 以下为局域网多人加固新增（可空或有默认值，回滚安全）=====

    // 任务状态：uploaded / queued / extracting / generating / done / failed
    @Column({ default: 'uploaded' })
    status!: string

    // 提取到的条目总数
    @Column({ nullable: true, type: 'integer' })
    itemCount!: number | null

    // 未定位到原文的条目数（需人工核查）
    @Column({ nullable: true, type: 'integer' })
    missCount!: number | null

    // 提取失败的文本块数量
    @Column({ nullable: true, type: 'integer' })
    failedBlocks!: number | null

    // 失败原因（写入时截断至 500 字符）
    @Column({ nullable: true, type: 'text' })
    errorMsg!: string | null

    // 最后状态更新时间（毫秒时间戳）；「最近任务列表」按此列倒序，故建索引
    @Index()
    @Column({ nullable: true, type: 'integer' })
    updatedAt!: number | null
}
