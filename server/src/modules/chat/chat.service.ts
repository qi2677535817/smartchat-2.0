import { Injectable } from '@nestjs/common';
import { Observable } from 'rxjs';
import { MessageEvent } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatMessageDto } from './chat.dto';

@Injectable()
export class ChatService {
  private readonly DEEPSEEK_BASE_URL: string;
  private readonly DEEPSEEK_API_KEY: string;

  constructor(private readonly configService: ConfigService){
    this.DEEPSEEK_BASE_URL = this.configService.get('DEEPSEEK_BASE_URL') ?? 'https://api.deepseek.com/v1/chat/completions';
    this.DEEPSEEK_API_KEY = this.configService.get('DEEPSEEK_API_KEY')!;
  }

  async sendChatMessage(messages: ChatMessageDto['messages'], model: ChatMessageDto['model']): Promise<any> {
    const response = await this.requestChat(messages, false, model);
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`DeepSeek API 错误 ${response.status}:${errorText}`);
    }
    const data = await response.json();
    return data.choices[0].message;
  }
  streamChat(messages: ChatMessageDto['messages'], model: ChatMessageDto['model']): Observable<MessageEvent> {
    return new Observable((observer) => {
      // 1. 调 DeepSeek API, stream: true
      this.requestChat(messages!, true, model)
        .then(async (response) => {
          if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`DeepSeek API 错误 ${response.status}:${errorText}`);
          }
          if(!response.body) {
            throw new Error('Response body is null');
          }
          const reader = response.body.getReader();
          const decoder = new TextDecoder('utf-8');
          let buffer = '';
          while (true) {
            const { done, value } = await reader.read();  
            if (done) {
              break;
            }
            const chunk = decoder.decode(value, { stream: true });
            /**
             * chunk 是 json 字符串，需要解析成 json 对象
             * {
             *  choices: [{
             *    delta: {
             *      role: string;
             *      content: string;    
             *    },
             *    index: number;
             *  }]
             * }
             */
            buffer += chunk;
            let lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (let i = 0; i < lines.length; i++) {
              const line = lines[i].trim();
              if (lines[i].trim() === '') continue;
              if(!line.startsWith('data:')) continue;
              const jsonStr = line.slice(5).trim();
              if(jsonStr === '[DONE]') {
                observer.complete();
                return;
              }
              const parsed = JSON.parse(jsonStr);
              const delta = parsed.choices[0].delta;
              const reasoning = delta.reasoning_content;
              const answer = delta.content;
              
              if(reasoning) {
                observer.next({ data: { type: 'reasoning', content: reasoning } });
              }
              if(answer) {
                observer.next({ data: { type: 'answer', content: answer } });
              }
            }
          }
          observer.complete();
        })
        .catch(error => {
          observer.error(error);
        })
    })
  }
  private async requestChat(messages: ChatMessageDto['messages'], stream: boolean, model: ChatMessageDto['model']) {
    return fetch(this.DEEPSEEK_BASE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.DEEPSEEK_API_KEY}`
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'system',
            content:`你是 SmartChat 智能助手。请遵循以下输出规范：
              1. 标题：使用 ##  时 # 后必须有空格
              2. 列表：使用 -  或 1.  时符号后必须有空格
              3. 段落：段落之间用空行（\n\n）分隔
              4. 代码块：用三个反引号包裹
            `
          },
          ...(messages ?? [])
        ],
        stream
      })
    })
  }
}
