import { Post, Controller, Body } from "@nestjs/common";
import { KnowledgeBaseDto } from "./knowledge-base.dto";
import { KnowledgeBaseService } from "./knowledge-base.service";

@Controller('knowledge-base')
export class KnowledgeBaseController {
    constructor(private readonly KnowledgeBaseService: KnowledgeBaseService) {}

    @Post('documents')
    async saveDocuments(@Body() body: KnowledgeBaseDto) {
        return this.KnowledgeBaseService.ingestDocument(body.name, body.content);
    }
}