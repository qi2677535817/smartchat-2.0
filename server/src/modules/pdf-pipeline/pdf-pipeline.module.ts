import { Module } from "@nestjs/common";
import { PythonPipelineService } from "./python-pipeline.service";

/**
 * PDF 管线模块（pdfplumber 子进程封装）
 *
 * 独立无业务依赖，供 tender（复核 HTML 生成）与 session（会话附件文本提取）共用，
 * 避免 TenderModule ↔ SessionModule ↔ ChatModule 之间的循环依赖。
 */
@Module({
    providers: [PythonPipelineService],
    exports: [PythonPipelineService],
})
export class PdfPipelineModule {}
