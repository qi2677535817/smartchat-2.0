import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ChatModule } from './modules/chat/chat.module';
import { ConfigModule } from '@nestjs/config';
import { EmbeddingModule } from './modules/embedding/embedding.module';
import { KnowledgeBaseModule } from './modules/knowledge-base/knowledge-base.module';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Message } from './modules/session/message.entity';
import { Session } from './modules/session/session.entity';
import { SessionModule } from './modules/session/session.module';

@Module({
  imports: [ChatModule, EmbeddingModule, KnowledgeBaseModule,SessionModule,
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRoot({
      type:"better-sqlite3",
      database:'data-cache/smartchat.db',
      entities: [Session, Message],
      synchronize: true
    })
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule { }