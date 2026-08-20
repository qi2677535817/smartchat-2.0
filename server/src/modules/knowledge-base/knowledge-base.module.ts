import { Module } from '@nestjs/common';
import { EmbeddingModule } from '../embedding/embedding.module';
import { KnowledgeBaseService } from './knowledge-base.service';
import { RetrievalEval } from './test';
import { ChunkingUtil } from './chunking.util';
import { FsUtil } from './fs.util';
import { KnowledgeBaseController } from './knowledge-base.controller';

@Module({
    imports: [EmbeddingModule],
    providers: [KnowledgeBaseService, RetrievalEval, ChunkingUtil, FsUtil],
    exports: [KnowledgeBaseService, RetrievalEval, ChunkingUtil, FsUtil],
    controllers: [KnowledgeBaseController]
})
export class KnowledgeBaseModule {}