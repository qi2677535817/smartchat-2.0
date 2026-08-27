import { Body, Controller, Delete, Get, Param, Post } from "@nestjs/common";
import { SessionService } from "./session.service";

@Controller('sessions')
export class SessionController {
    constructor(private readonly sessionService:SessionService) {

    }
    @Get()
    getSessions() {
        return this.sessionService.getSessions()
    }
    @Post()
    saveSessions(@Body() body) {
        return this.sessionService.saveSessions(body)
    }
    @Delete(':id')
    deleteSessions(@Param('id') id) {
        return this.sessionService.deleteSessions(id)
    }

    @Get(':id/messages')
    getMessages(@Param('id') id) {
        return this.sessionService.getMessages(id)
    }
    @Post(':id/messages')
    saveMessages(@Param('id') id , @Body() body) {
        return this.sessionService.saveMessages(id, body)
    }
}