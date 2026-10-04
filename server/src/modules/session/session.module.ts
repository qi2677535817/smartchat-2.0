import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { Message } from "./message.entity";
import { Session } from "./session.entity";
import { SessionAttachment } from "./session-attachment.entity";
import { SessionController } from "./session.controller";
import { SessionService } from "./session.service";
import { SessionAttachmentController } from "./session-attachment.controller";
import { SessionAttachmentService } from "./session-attachment.service";
import { PdfPipelineModule } from "../pdf-pipeline/pdf-pipeline.module";
import { EmbeddingModule } from "../embedding/embedding.module";

@Module({
    imports: [
        TypeOrmModule.forFeature([Session, Message, SessionAttachment]),
        // 复用 PDF 提取（PdfPipelineModule）与向量化能力
        PdfPipelineModule,
        EmbeddingModule,
    ],
    providers: [SessionService, SessionAttachmentService],
    controllers: [SessionController, SessionAttachmentController],
    exports: [SessionAttachmentService],
})
export class SessionModule {}
