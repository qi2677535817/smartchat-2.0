import { Injectable, Logger } from '@nestjs/common';
import { Observable } from 'rxjs';
import { MessageEvent } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatMessageDto, ChatMessage } from './chat.dto';
import { tools, toolHandlers } from './tools'
import { EmbeddingService } from '../embedding/embedding.service';
import { log } from 'console';

@Injectable()
export class ChatService {
  private readonly DEEPSEEK_BASE_URL: string;
  private readonly DEEPSEEK_API_KEY: string;

  constructor(private readonly configService: ConfigService, private readonly embeddingService: EmbeddingService) {
    this.DEEPSEEK_BASE_URL =
      this.configService.get('DEEPSEEK_BASE_URL') ??
      'https://api.deepseek.com/v1/chat/completions';
    this.DEEPSEEK_API_KEY = this.configService.get('DEEPSEEK_API_KEY')!;
  }

  async sendChatMessage(
    messages: ChatMessageDto['messages'],
    model: ChatMessageDto['model'],
  ): Promise<any> {
    return this.runChatLoopNonStream(messages, model);
  }
  // 流式请求大模型
  streamChat(
    messages: ChatMessageDto['messages'],
    model: ChatMessageDto['model'],
  ): Observable<MessageEvent> {
    return new Observable((observer) => {
      this.runChatLoop(messages, model, observer);
    });
  }
  /**
 * 非流式工具调用循环
   *
   * 核心逻辑：
   * 1. 调用模型
   * 2. 如果模型返回 tool_calls，执行工具并把结果追加到 messages
   * 3. 再次调用模型，直到模型返回普通文本回答
   */
  private async runChatLoopNonStream(
    messages: ChatMessage[],
    model: ChatMessageDto['model'],
  ): Promise<any> {
    // 复制一份 messages，避免修改外部传入的数组
    let currentMessages: ChatMessage[] = [...(messages ?? [])];

    while (true) {
      const response = await this.requestChat(currentMessages, false, model, undefined, tools);
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`DeepSeek API 错误 ${response.status}:${errorText}`);
      }

      const data = await response.json();
      const message = data.choices[0].message;
      const finishReason = data.choices[0].finish_reason;

      // 把模型这次返回的消息加入历史
      currentMessages.push(message);

      // 如果模型没有调用工具，直接返回
      if (finishReason !== 'tool_calls' && !message.tool_calls?.length) {
        return message;
      }

      // 模型要求调用工具，逐个执行
      const toolResults = await this.executeToolCalls(message.tool_calls);

      // 把工具执行结果追加到历史
      currentMessages.push(...toolResults);

      // 继续循环，让模型根据工具结果生成最终回答
    }
  }

  /**
   * 流式请求大模型
   *
   * 流式工具调用比非流式复杂，因为 tool_calls 的每个字段都是分段返回的：
   * 第一次可能只返回 index 和 id，接着返回 function.name，再返回 function.arguments 的片段。
   * 必须按 index 累积，等整个流结束后才能执行工具。
   */
  private async runChatLoop(
    messages: ChatMessage[],
    model: ChatMessageDto['model'],
    observer: any,
  ) {
    // 用于中断对大模型的流式请求
    const abortController = new AbortController();
    // 复制一份 messages，避免修改外部传入的数组
    let currentMessages: ChatMessage[] = [...(messages ?? [])];

    try {
      while (true) {
        const response = await this.requestChat(
          currentMessages,
          true,
          model,
          abortController.signal,
          tools,
        );

        if (!response.ok) {
          const errorText = await response.text();
          observer.error(
            new Error(`DeepSeek API 错误 ${response.status}:${errorText}`),
          );
          return;
        }

        if (!response.body) {
          observer.error(new Error('Response body is null'));
          return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';

        // 累积当前这轮流式返回的 assistant 消息
        let assistantMessage: {
          role: 'assistant';
          content: string;
          reasoning_content: string;
          tool_calls: Record<
            number,
            { id?: string; type?: string; function: { name?: string; arguments?: string } }
          >;
        } = {
          role: 'assistant',
          content: '',
          reasoning_content: '',
          tool_calls: {},
        };

        let finishReason: string | null = null;
        let hasOutputContent = false;

        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }

          const chunk = decoder.decode(value, { stream: true });
          buffer += chunk;
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (line === '') continue;
            if (!line.startsWith('data:')) continue;

            const jsonStr = line.slice(5).trim();
            if (jsonStr === '[DONE]') {
              break;
            }

            const parsed = JSON.parse(jsonStr);
            const delta = parsed.choices[0].delta;
            finishReason = parsed.choices[0].finish_reason ?? finishReason;

            // 累积 reasoning_content（思维链内容）
            if (delta.reasoning_content) {
              assistantMessage.reasoning_content += delta.reasoning_content;
              observer.next({
                data: { type: 'reasoning', content: delta.reasoning_content },
              });
              hasOutputContent = true;
            }

            // 累积普通文本回答
            if (delta.content) {
              assistantMessage.content += delta.content;
              observer.next({ data: { type: 'answer', content: delta.content } });
              hasOutputContent = true;
            }

            // 累积工具调用片段
            if (delta.tool_calls && delta.tool_calls.length > 0) {
              for (const toolCallDelta of delta.tool_calls) {
                const index = toolCallDelta.index;
                if (!assistantMessage.tool_calls[index]) {
                  assistantMessage.tool_calls[index] = {
                    function: {},
                  };
                }

                const acc = assistantMessage.tool_calls[index];
                if (toolCallDelta.id) acc.id = toolCallDelta.id;
                if (toolCallDelta.type) acc.type = toolCallDelta.type;
                if (toolCallDelta.function?.name) {
                  acc.function.name = toolCallDelta.function.name;
                }
                if (toolCallDelta.function?.arguments) {
                  acc.function.arguments =
                    (acc.function.arguments ?? '') + toolCallDelta.function.arguments;
                }
              }
              hasOutputContent = true;
            }
          }
        }

        // 把累积的 assistant 消息加入历史
        // 注意：只有真正返回了内容才加入；如果流被 abort 则不要加
        if (hasOutputContent) {
          const normalizedToolCalls = Object.entries(assistantMessage.tool_calls).map(
            ([index, tc]) => ({
              id: tc.id ?? '',
              type: tc.type ?? 'function',
              function: {
                name: tc.function.name ?? '',
                arguments: tc.function.arguments ?? '',
              },
            }),
          );

          if (normalizedToolCalls.length > 0) {
            currentMessages.push({
              role: assistantMessage.role,
              content: assistantMessage.content || null,
              tool_calls: normalizedToolCalls,
            });
          } else {
            currentMessages.push({
              role: assistantMessage.role,
              content: assistantMessage.content,
            });
          }

          // 如果这轮流以 tool_calls 结束，执行工具后继续循环
          if (finishReason === 'tool_calls' || normalizedToolCalls.length > 0) {
            const toolResults = await this.executeToolCalls(normalizedToolCalls);
            currentMessages.push(...toolResults);
            // 继续下一轮，让模型根据工具结果生成最终回答
            continue;
          }
        }

        // 正常结束，没有更多工具调用
        observer.complete();
        return;
      }
    } catch (error) {
      // 用户主动断开连接或调用 abort 时，AbortError 是正常的，不需要抛错
      if (error instanceof Error && error.name === 'AbortError') {
        observer.complete();
        return;
      }
      observer.error(error);
    }
  }

  /**
   * 执行模型要求的工具调用
   *
   * @param toolCalls 模型返回的 tool_calls 数组
   * @returns 工具执行结果消息数组，可直接追加到 messages
   */
  private async executeToolCalls(
    toolCalls: Array<{
      id: string;
      type: string;
      function: { name: string; arguments: string };
    }>,
  ): Promise<Array<{ role: 'tool'; content: string; tool_call_id: string }>> {
    const results: Array<{ role: 'tool'; content: string; tool_call_id: string }> = [];

    for (const toolCall of toolCalls) {
      const { name, arguments: argsStr } = toolCall.function;
      const handler = toolHandlers[name];

      if (!handler) {
        results.push({
          role: 'tool',
          content: `错误：未找到名为 "${name}" 的工具执行器`,
          tool_call_id: toolCall.id,
        });
        continue;
      }

      try {
        // arguments 是 JSON 字符串，需要解析成对象再传给 handler
        const args = argsStr ? JSON.parse(argsStr) : {};
        const result = await handler(args);

        results.push({
          role: 'tool',
          content: typeof result === 'string' ? result : JSON.stringify(result),
          tool_call_id: toolCall.id,
        });
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        results.push({
          role: 'tool',
          content: `工具执行出错：${errorMessage}`,
          tool_call_id: toolCall.id,
        });
      }
    }

    return results;
  }

  private async requestChat(
    messages: ChatMessage[],
    stream: boolean,
    model: ChatMessageDto['model'],
    signal?: AbortSignal,
    tools?: ChatMessageDto['tools'],
  ) {
    const body = {
      model,
      messages: [
        {
          role: 'system',
          content: `你是 SmartChat 智能助手。当用户的问题适合使用工具时，请先调用工具再回答。请遵循以下输出规范：
              1. 标题：使用 ##  时 # 后必须有空格
              2. 列表：使用 -  或 1.  时符号后必须有空格
              3. 段落：段落之间用空行（\n\n）分隔
              4. 代码块：用三个反引号包裹
            `,
        },
        ...(messages ?? []),
      ],
      stream,
      tools,
      tool_choice: 'auto',
    };
    // console.log('【请求大模型】body:', JSON.stringify(body, null, 2));
    return fetch(this.DEEPSEEK_BASE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.DEEPSEEK_API_KEY}`,
      },
      body: JSON.stringify(body),
      signal,
    });
  }
}
