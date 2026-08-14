import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'

@Injectable()
export class EmbeddingService {
    private readonly EMBEDDING_BASE_URL: string
    private readonly EMBEDDING_API_KEY: string
    private readonly EMBEDDING_MODEL: string

    constructor(private readonly configService: ConfigService) {
        this.EMBEDDING_BASE_URL = this.configService.get('EMBEDDING_BASE_URL')!
        this.EMBEDDING_API_KEY = this.configService.get('EMBEDDING_API_KEY')!
        this.EMBEDDING_MODEL = this.configService.get('EMBEDDING_MODEL')!
    }

    async embedText(text: string): Promise<number[]> {
        const response = await fetch(this.EMBEDDING_BASE_URL, {
            method: 'POST',
            headers:{
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.EMBEDDING_API_KEY}`
            },
            body:JSON.stringify({
                model: this.EMBEDDING_MODEL,
                input: text
            })
        })
        if(!response.ok) {
            let errorText = await response.text()
            throw new Error(`错误信息${ response.status }:${ errorText }`)
        }
        const data = await response.json()
        return data.data[0].embedding
    }
}