import { IsNotEmpty, IsString } from "class-validator";

export class KnowledgeBaseDto {
  @IsString()
  @IsNotEmpty()
  name: string = '';

  @IsNotEmpty()
  @IsString()
  content: string = ''
}