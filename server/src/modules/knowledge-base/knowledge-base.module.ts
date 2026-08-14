import { Module } from '@nestjs/common';
import { EmbeddingModule } from '../embedding/embedding.module';
import { KnowledgeBaseService } from './knowledge-base.service';
import { ChunkingUtil } from './chunking.util';

@Module({
    imports: [EmbeddingModule],
    providers: [KnowledgeBaseService, ChunkingUtil],
    exports: [KnowledgeBaseService, ChunkingUtil]
})
export class KnowledgeBaseModule {}