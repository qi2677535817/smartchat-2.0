import { Injectable, OnModuleInit } from "@nestjs/common";
import { EmbeddingService } from "../embedding/embedding.service";
import { ChunkingUtil } from "./chunking.util";
import { FsUtil } from "./fs.util";
import path from "node:path";

@Injectable()
export class KnowledgeBaseService implements OnModuleInit {
    constructor(private readonly embeddingService: EmbeddingService) {
    }
    private chunks: {
        vector: number[],
        text: string,
        source?: string,
        index?: number,
    }[] = []
    // 向量比对相似度
    async compareSimilarity(query: string): Promise<{
        score: number,
        index: number,
        content: string
    }[]> {
        if(this.chunks.length === 0) {
            return []
        }
        let parameter1 = await this.embeddingService.embedText(query)
        // 获取文件数据中的向量
        let cosineSimilarityList: {
            score: number,
            index: number,
            content: string
        }[] = []
        for (let k = 0; k < this.chunks.length; k++) {
            let dot1 = 0
            let sumSql1 = 0
            let sumSql2 = 0
            for (let i = 0; i < parameter1.length; i++) {
                dot1 += parameter1[i] * this.chunks[k].vector[i]
                sumSql1 += parameter1[i] * parameter1[i]
                sumSql2 += this.chunks[k].vector[i] * this.chunks[k].vector[i]
            }
            let cosineSimilarity = dot1 / (Math.sqrt(sumSql1) * Math.sqrt(sumSql2))
            cosineSimilarityList.push({
                score: cosineSimilarity,
                index: this.chunks[k].index!,
                content: this.chunks[k].text
            })
        }
        return cosineSimilarityList
    }
    /**
     * 添加文档
     * @param document 文档内容数组
     * @returns 嵌入向量数组
     */
    async addDocument(name: string, content: string) {
        let list: {
            text: string,
            vector: number[],
            name: string,
            index: number
        }[] = []
        let document: string[] = []
        // 先对内容进行分块
        if (content.length > 0) {
            document = ChunkingUtil.chunking(content, 50)
        }
        if (document.length > 0) {
            // TODO: 实现文档添加逻辑
            for (let i = 0; i < document.length; i++) {
                let parameter = await this.embeddingService.embedText(document[i])
                list.push({
                    text: document[i],
                    vector: parameter,
                    name,
                    index: i
                })
            }
        }
        return list
    }
    async onModuleInit() {
        // 读取目录
        let menu = await FsUtil.readMenu('knowledge-data')
        let files: {
            text,
            vector,
            name
        }[] = []
        let embeddingData: {
            text: string,
            vector: number[],
            name: string,
            source?: string,
            index?: number,
        }[] = []
        try {
            // 先获取向量文件中已加载的数据列表
            embeddingData = JSON.parse(await FsUtil.readFile(path.join('data-cache', 'knowledge-base.json')))
        } catch (e) {
            throw new Error('读取向量文件失败: ' + e);
        }
        // 循环加载目录中的文件，如果已经加载过了，则不需要加载
        for (let i = 0; i < menu.length; i++) {
            let file = await FsUtil.readFile(path.join('knowledge-data', menu[i]))
            if (embeddingData.findIndex(item => item.name === menu[i]) === -1) {
                files.push(...await this.addDocument(menu[i], file))
            }
        }
        // 将内容写入rag文件
        if (files.length > 0) {
            await FsUtil.writeFile(path.join('data-cache', 'knowledge-base.json'), JSON.stringify([...embeddingData, ...files], null, 2))
        }
        this.chunks = [...files, ...embeddingData]
    }
}
