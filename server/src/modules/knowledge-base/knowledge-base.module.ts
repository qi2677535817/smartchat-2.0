import { Module } from '@nestjs/common';
import { EmbeddingModule } from '../embedding/embedding.module';
import { KnowledgeBaseService } from './knowledge-base.service';
import { testFunction } from './test';
import { ChunkingUtil } from './chunking.util';
import { FsUtil } from './fs.util';
import { KnowledgeBaseController } from './knowledge-base.controller';

@Module({
    imports: [EmbeddingModule],
    providers: [KnowledgeBaseService, testFunction, ChunkingUtil, FsUtil],
    exports: [KnowledgeBaseService, testFunction, ChunkingUtil, FsUtil],
    controllers: [KnowledgeBaseController]
})
export class KnowledgeBaseModule {}