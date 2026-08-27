import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { Message } from "./message.entity";
import { Session } from "./session.entity";
import { SessionController } from "./session.controller";
import { SessionService } from "./session.service";

@Module({
    imports:[TypeOrmModule.forFeature([Session, Message])],
    providers:[SessionService],
    controllers:[SessionController]
})
export class SessionModule {}
