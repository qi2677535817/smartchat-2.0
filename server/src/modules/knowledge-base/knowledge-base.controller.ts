import { Post, Controller, Body, Get, Delete, Param } from "@nestjs/common";
import { KnowledgeBaseDto, DocumentsDto } from "./knowledge-base.dto";
import { KnowledgeBaseService } from "./knowledge-base.service";
import { RetrievalEval } from "./test";

@Controller('knowledge-base')
export class KnowledgeBaseController {
    constructor(private readonly KnowledgeBaseService: KnowledgeBaseService,
        private readonly retrievalEval: RetrievalEval
    ) {}

    @Post('documents')
    async saveDocuments(@Body() body: KnowledgeBaseDto) {
        const mtime = Date.now()
        return this.KnowledgeBaseService.ingestDocument(body.name, body.content, mtime);
    }
    @Get('eval')
    async getTest() {
        return this.retrievalEval.test()
    }
    @Get('documents')
    async getDocuments() {
        return this.KnowledgeBaseService.getRagData()
    }
    @Delete('documents/:name')
    async deleteDocuments(@Param('name') name:string) {
        return this.KnowledgeBaseService.deleteRagData(name)
    }
}