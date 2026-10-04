import { Module } from '@nestjs/common';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { EmbeddingModule } from '../embedding/embedding.module';
import { KnowledgeBaseModule } from '../knowledge-base/knowledge-base.module';
import { SessionModule } from '../session/session.module';

@Module({
  controllers: [ChatController],
  providers: [ChatService],
  imports: [EmbeddingModule, KnowledgeBaseModule, SessionModule],
  // 导出 ChatService：供 tender 提取复用其 FC 循环（runToolLoop）
  exports: [ChatService],
})
export class ChatModule {}
