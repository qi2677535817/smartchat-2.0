import { Post, Controller, Body, Get } from "@nestjs/common";
import { KnowledgeBaseDto } from "./knowledge-base.dto";
import { KnowledgeBaseService } from "./knowledge-base.service";
import { testFunction } from "./test";

@Controller('knowledge-base')
export class KnowledgeBaseController {
    constructor(private readonly KnowledgeBaseService: KnowledgeBaseService,
        private readonly testFunction: testFunction
    ) {}

    @Post('documents')
    async saveDocuments(@Body() body: KnowledgeBaseDto) {
        return this.KnowledgeBaseService.ingestDocument(body.name, body.content);
    }
    @Get('test')
    async getTest() {
        return this.testFunction.test()
    }
}