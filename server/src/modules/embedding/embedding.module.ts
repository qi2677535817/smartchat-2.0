import { Module } from "@nestjs/common";
import { EmbeddingService } from "./embedding.service";
import { RerankService } from "./rerank.service";

@Module({
    providers: [EmbeddingService, RerankService],
    exports: [EmbeddingService, RerankService]
})

export class EmbeddingModule{}