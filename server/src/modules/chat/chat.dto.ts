import {
  IsString,
  IsNotEmpty,
  IsArray,
  IsOptional,
  ArrayNotEmpty,
} from 'class-validator';

// 单条对话消息，支持普通角色和工具调用相关角色
export type ChatMessage =
  | {
      role: 'system' | 'user' | 'assistant';
      content: string;
      reasoning_content?: string;
    }
  | {
      role: 'assistant';
      content?: string | null;
      reasoning_content?: string;
      tool_calls: Array<{
        id: string;
        type: string;
        function: {
          name: string;
          arguments: string;
        };
      }>;
    }
  | {
      role: 'tool';
      content: string;
      tool_call_id: string;
    };

export class ChatMessageDto {
  @IsArray()
  @ArrayNotEmpty()
  messages: ChatMessage[] = [];

  @IsString()
  @IsNotEmpty()
  model: string = 'deepseek-v4-flash';

  // 会话 id：用于检索该会话的附件（可选，兼容历史请求）
  @IsOptional()
  @IsString()
  sessionId?: string;

  @IsOptional()
  @IsArray()
  tools: Array<{
    type: string;
    function: {
      name: string;
      description: string;
      parameters: {
        type: string;
        properties: object;
        required: Array<string>;
      };
    };
  }> = [];
}
