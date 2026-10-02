import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { TenderDocument } from "./tender-document.entity";

// 标书复核服务 —— 上传受理、落盘、编排
@Injectable()
export class TenderService {
    constructor(
        @InjectRepository(TenderDocument)
        private readonly tenderDocRepo: Repository<TenderDocument>,
    ) {}
}
