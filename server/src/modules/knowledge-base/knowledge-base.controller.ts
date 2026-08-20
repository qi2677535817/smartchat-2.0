import { Post, Controller, Body, Get } from "@nestjs/common";
import { KnowledgeBaseDto } from "./knowledge-base.dto";
import { KnowledgeBaseService } from "./knowledge-base.service";
import { RetrievalEval } from "./test";

@Controller('knowledge-base')
export class KnowledgeBaseController {
    constructor(private readonly KnowledgeBaseService: KnowledgeBaseService,
        private readonly retrievalEval: RetrievalEval
    ) {}

    @Post('documents')
    async saveDocuments(@Body() body: KnowledgeBaseDto) {
        return this.KnowledgeBaseService.ingestDocument(body.name, body.content, body.mtime);
    }
    @Get('eval')
    async getTest() {
        return this.retrievalEval.test()
    }
}