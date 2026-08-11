import {
  IsString,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsEnum,
  IsArray,
  IsObject,
  ArrayNotEmpty,
} from 'class-validator';
export class ChatMessageDto {
  @IsArray()
  @ArrayNotEmpty()
  messages: Array<{
    role: 'system' | 'user' | 'assistant';
    content: string;
    reasoning_content?: string;
  }> = [];
  
  @IsString()
  @IsNotEmpty()
  model: string = 'deepseek-v4-flash';
}
