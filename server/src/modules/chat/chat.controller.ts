import { Body, Controller, Get, Post } from '@nestjs/common';
import { ChatService } from './chat.service';
import { ChatMessageDto } from './chat.dto';

@Controller('chat')
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  @Get()
  getChat(content) {
    return this.chatService.sendChatMessage(content);
  }

  @Post('message')
  postChat(@Body() body: ChatMessageDto) {
    return this.chatService.sendChatMessage(body.content);
  }
}
