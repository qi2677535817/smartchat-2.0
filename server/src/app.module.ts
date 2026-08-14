import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ChatModule } from './modules/chat/chat.module';
import { ConfigModule } from '@nestjs/config';
import { EmbeddingModule } from './modules/embedding/embedding.module';
import { KnowledgeBaseModule } from './modules/knowledge-base/knowledge-base.module';

@Module({
  imports: [ChatModule, EmbeddingModule, KnowledgeBaseModule, ConfigModule.forRoot({ isGlobal: true })],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
