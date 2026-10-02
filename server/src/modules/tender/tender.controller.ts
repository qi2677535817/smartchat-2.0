import { Controller } from "@nestjs/common";
import { TenderService } from "./tender.service";

// 标书复核端点 —— 任务 2 实现 POST /tender/review，任务 4 实现下载
@Controller('tender')
export class TenderController {
    constructor(private readonly tenderService: TenderService) {}
}
