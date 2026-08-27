import { Column, Entity, OneToMany, PrimaryColumn, PrimaryGeneratedColumn } from "typeorm";
import { Message } from "./message.entity";

@Entity('sessions')
export class Session{
    @PrimaryGeneratedColumn('uuid')
    id!: string

    @OneToMany(() => Message, (message) => message.session)
    messages?:Message[]

    @Column()
    title!: string

    @Column()
    createdAt!: number
}