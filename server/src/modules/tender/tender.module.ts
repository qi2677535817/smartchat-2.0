import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { TenderDocument } from "./tender-document.entity";
import { TenderController } from "./tender.controller";
import { TenderService } from "./tender.service";
import { PythonPipelineService } from "./python-pipeline.service";

// 标书复核模块 —— 阶段 1：Python 管线服务化
@Module({
    imports: [TypeOrmModule.forFeature([TenderDocument])],
    providers: [TenderService, PythonPipelineService],
    controllers: [TenderController],
    // 导出 PythonPipelineService：供 session 模块做 PDF 附件文本提取
    exports: [PythonPipelineService],
})
export class TenderModule {}
