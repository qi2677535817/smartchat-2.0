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
import { SessionAttachment } from './modules/session/session-attachment.entity';
import { TenderModule } from './modules/tender/tender.module';
import { TenderDocument } from './modules/tender/tender-document.entity';

@Module({
  imports: [ChatModule, EmbeddingModule, KnowledgeBaseModule,SessionModule, TenderModule,
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRoot({
      type:"better-sqlite3",
      database:'data-cache/smartchat.db',
      entities: [Session, Message, SessionAttachment, TenderDocument],
      synchronize: true,
      // 局域网多人并发加固（openspec/changes/harden-lan-multiuser，design §7）：
      // 开启 WAL 让读写不互斥；写锁等待 5s 再判失败，避免并发上传时直接抛 SQLITE_BUSY
      enableWAL: true,
      timeout: 5000,
      prepareDatabase: (db: any) => {
        // WAL 模式下 synchronous=NORMAL 兼顾安全与吞吐（崩溃最多回退一个事务）
        db.pragma('synchronous = NORMAL')
      },
      // 技术债（显式记录）：synchronize 仍为 true，多人写场景应改为显式迁移，另起变更处理
    })
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule { }