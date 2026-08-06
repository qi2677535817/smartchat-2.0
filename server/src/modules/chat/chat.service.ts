import { Injectable } from '@nestjs/common';

@Injectable()
export class ChatService {
  sendChatMessage(content: string) {
    return {
      content: `我收到你的消息：${content}， 回复模拟数据`,
      role: 'assistant',
    };
  }
}
