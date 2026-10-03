import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { Message } from "./message.entity";
import { Session } from "./session.entity";
import { SessionAttachment } from "./session-attachment.entity";
import { SessionController } from "./session.controller";
import { SessionService } from "./session.service";
import { SessionAttachmentController } from "./session-attachment.controller";
import { SessionAttachmentService } from "./session-attachment.service";
import { TenderModule } from "../tender/tender.module";
import { EmbeddingModule } from "../embedding/embedding.module";

@Module({
    imports: [
        TypeOrmModule.forFeature([Session, Message, SessionAttachment]),
        // 复用 PDF 提取（TenderModule exports PythonPipelineService）与向量化能力
        TenderModule,
        EmbeddingModule,
    ],
    providers: [SessionService, SessionAttachmentService],
    controllers: [SessionController, SessionAttachmentController],
    exports: [SessionAttachmentService],
})
export class SessionModule {}
