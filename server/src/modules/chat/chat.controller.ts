import { Body, Controller, Get, Post, Sse } from '@nestjs/common';
import { ChatService } from './chat.service';
import { ChatMessageDto } from './chat.dto';
import { METHOD_METADATA } from '@nestjs/common/constants';
import { interval, map, Observable, take } from 'rxjs';

@Controller('chat')
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  @Post('message')
  postChat(@Body() body: ChatMessageDto) {
    return this.chatService.sendChatMessage(body.messages, body.model);
  }

  @Post('stream')
  @Sse()
  streamChat(@Body() body: ChatMessageDto) {
    return this.chatService.streamChat(body.messages, body.model);
  }
}
