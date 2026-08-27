import { InjectRepository } from "@nestjs/typeorm";
import { Session } from "./session.entity";
import { Repository } from "typeorm";
import { Message } from "./message.entity";
import { Injectable } from "@nestjs/common";

@Injectable()
export class SessionService {
    constructor(@InjectRepository(Session) private readonly sessionRepo: Repository<Session>,
    @InjectRepository(Message) private readonly messageRepo: Repository<Message>
    ) {

    }

    getSessions() {
        return this.sessionRepo.find({
            order: {
                createdAt: 'ASC'
            }
        })
    }

    saveSessions(body: {
        title: string
    }) {
        let session = new Session()
        session.title = body.title
        session.createdAt = Date.now()

        return this.sessionRepo.save(session)
    }

    deleteSessions(id: string) {
        return this.sessionRepo.delete(id)
    }

    getMessages(id) {
        return this.messageRepo.find({
            where: {
                sessionId: id
            },
            order: {
                id: 'ASC'
            }
        })
    }

    saveMessages(id, body) {
        let messages = new Message()
        messages.content = body.content
        messages.role = body.role
        messages.reasoning = body.reasoning_content
        messages.createdAt = Date.now()
        messages.sessionId = id

        return this.messageRepo.save(messages)
    }
}