import {
  IsString,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsEnum,
} from 'class-validator';

export class ChatMessageDto {
  @IsString()
  @IsNotEmpty()
  content!: string;
}
