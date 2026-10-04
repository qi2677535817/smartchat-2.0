import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { TenderDocument } from "./tender-document.entity";
import { TenderController } from "./tender.controller";
import { TenderService } from "./tender.service";
import { TenderExtractionService } from "./tender-extraction.service";
import { PdfPipelineModule } from "../pdf-pipeline/pdf-pipeline.module";
import { ChatModule } from "../chat/chat.module";

// 标书复核模块 —— 阶段 1：Python 管线服务化；阶段 2：FC 自动提取
// 依赖 ChatModule 以复用既有 FC 循环（红线 5：不新写 Agent 引擎）
@Module({
    imports: [TypeOrmModule.forFeature([TenderDocument]), PdfPipelineModule, ChatModule],
    providers: [TenderService, TenderExtractionService],
    controllers: [TenderController],
})
export class TenderModule {}
