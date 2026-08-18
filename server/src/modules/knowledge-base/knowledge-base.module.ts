import { Module } from '@nestjs/common';
import { EmbeddingModule } from '../embedding/embedding.module';
import { KnowledgeBaseService } from './knowledge-base.service';
import { ChunkingUtil } from './chunking.util';
import { FsUtil } from './fs.util';

@Module({
    imports: [EmbeddingModule],
    providers: [KnowledgeBaseService, ChunkingUtil, FsUtil],
    exports: [KnowledgeBaseService, ChunkingUtil, FsUtil]
})
export class KnowledgeBaseModule {}