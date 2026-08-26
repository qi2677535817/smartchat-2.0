import { IsNotEmpty, IsNumber, IsString } from "class-validator";

export class KnowledgeBaseDto {
  @IsString()
  @IsNotEmpty()
  name: string = '';

  @IsNotEmpty()
  @IsString()
  content: string = ''

  @IsNotEmpty()
  @IsNumber()
  mtime: number = 0
}

export class DocumentsDto {
  @IsString()
  @IsNotEmpty()
  name: string = ''
}