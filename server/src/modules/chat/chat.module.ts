import { Module } from '@nestjs/common';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { EmbeddingModule } from '../embedding/embedding.module';

@Module({
  controllers: [ChatController],
  providers: [ChatService],
  imports: [EmbeddingModule]
})
export class ChatModule {}
