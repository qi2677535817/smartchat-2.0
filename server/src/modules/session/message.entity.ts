import { Session } from "./session.entity";
import { Column, Entity, ManyToOne, PrimaryGeneratedColumn } from "typeorm";

@Entity('messages')
export class Message {
    @PrimaryGeneratedColumn('increment')
    id!: number

    @ManyToOne(() => Session, (session) => session.messages, { onDelete: 'CASCADE' })
    session?: Session

    @Column()
    sessionId!: string
    
    @Column()
    role!: string

    @Column({
        type: 'text'
    })
    content!: string

    @Column({
        type: 'text',
        nullable: true
    })
    reasoning?: string

    @Column()
    createdAt!: number

    @Column({
        type: 'text',
        nullable: true
    })
    citations?: string
}