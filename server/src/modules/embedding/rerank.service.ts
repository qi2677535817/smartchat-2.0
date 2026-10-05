import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

@Injectable()
export class RerankService {
    private readonly RERANK_BASE_URL: string;
    private readonly RERANK_API_KEY: string;
    private readonly RERANK_MODEL: string;

    constructor(private readonly configService: ConfigService) {
        this.RERANK_BASE_URL = this.configService.get('RERANK_BASE_URL')!
        this.RERANK_API_KEY =
            this.configService.get('RERANK_API_KEY') ??
            this.configService.get('EMBEDDING_API_KEY')!
        this.RERANK_MODEL = this.configService.get('RERANK_MODEL')!
    }

    async getRerankList(query, documents) {
        const res = await fetch(this.RERANK_BASE_URL, {
            method:"POST",
            headers:{
                'Content-Type': "application/json",
                'Authorization': `Bearer ${this.RERANK_API_KEY}`
            },
            body: JSON.stringify({
                model: this.RERANK_MODEL,
                query,
                documents
            })
        })
        if(!res.ok) {
            let errorText = await res.text()
            throw new Error(`错误信息${ res.status }:${ errorText }`)
        }
        const data = await res.json()
        return data.results
    }
}