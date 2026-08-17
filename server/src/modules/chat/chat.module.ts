import { Module } from '@nestjs/common';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { EmbeddingModule } from '../embedding/embedding.module';
import { KnowledgeBaseModule } from '../knowledge-base/knowledge-base.module';

@Module({
  controllers: [ChatController],
  providers: [ChatService],
  imports: [EmbeddingModule, KnowledgeBaseModule]
})
export class ChatModule {}
