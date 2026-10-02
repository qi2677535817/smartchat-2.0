import { Column, Entity, PrimaryGeneratedColumn } from "typeorm";

// 招标文件表 —— 字段按 PRD 决策 D3 拍板
// pageCount / pageOffset 允许为空，由阶段 2（FC 提取）填充
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
}
