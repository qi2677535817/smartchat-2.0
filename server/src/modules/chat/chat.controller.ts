import { Body, Controller, Get, Post, Sse } from '@nestjs/common';
import { ChatService } from './chat.service';
import { ChatMessageDto } from './chat.dto';
import { METHOD_METADATA } from '@nestjs/common/constants';
import { interval, map, Observable, take } from 'rxjs';

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

  @Post('stream')
  @Sse()
  streamChat(@Body() body: ChatMessageDto) {
    return this.chatService.streamChat(body.content)
  }
}
