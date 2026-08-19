import { Injectable, OnModuleInit, Logger } from "@nestjs/common";
import { EmbeddingService } from "../embedding/embedding.service";
import { ChunkingUtil } from "./chunking.util";
import { FsUtil } from "./fs.util";
import path from "node:path";

@Injectable()
export class KnowledgeBaseService implements OnModuleInit {
    constructor(private readonly embeddingService: EmbeddingService) {
    }
    private readonly logger = new Logger(KnowledgeBaseService.name)

    private chunks: {
        vector: number[],
        text: string,
        index?: number,
        name: string
    }[] = []
    // 向量比对相似度
    async compareSimilarity(query: string): Promise<{
        score: number,
        index: number,
        content: string,
        name: string
    }[]> {
        if(this.chunks.length === 0) {
            return []
        }
        let parameter1 = await this.embeddingService.embedText(query)
        // 获取文件数据中的向量
        let cosineSimilarityList: {
            score: number,
            index: number,
            content: string,
            name: string
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
                content: this.chunks[k].text,
                name: this.chunks[k].name
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
            document = ChunkingUtil.chunking(content, 200)
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
    /**
     * 同名检查
     */
    async ingestDocument(name: string, content: string) {
        // 对比chunks中是否有相同的name
        if(this.chunks.length > 0 && this.chunks.some(item => item.name === name)) {
            return { msg: '文件名已存在' }
        } 
        let files:{
            text,
            vector,
            name
        }[] = [] // 初始化文件
        let embeddingData: {
            text: string,
            vector: number[],
            name: string,
            index: number
        }[] = [] // 初始化向量数据
        // node中如果获取文件路径失败会报错，这里需要处理
        try {
            // 获取向量文件中已加载的数据列表
            embeddingData = JSON.parse(await FsUtil.readFile(path.join('data-cache', 'knowledge-vectors.json')))
        } catch(e) {
            this.logger.error('读取向量文件失败: ' + e)
        }
        if(embeddingData.length > 0 && embeddingData.some(item => item.name === name)) {
            return { msg: '文件名已存在', code: -1 }
        }
        // 将传入文件内容存入向量数据库，同时写入向量数据库
        files.push(...await this.addDocument(name, content))
        await FsUtil.writeFile(path.join('data-cache', 'knowledge-vectors.json'), JSON.stringify([...embeddingData, ...files], null, 2))
        this.chunks = [...embeddingData, ...files]
        return { msg:"文件存入成功", code: 0 }
    }
    async onModuleInit() {
        // 读取目录
        let menu = await FsUtil.readMenu('knowledge-data')
        // 循环加载目录中的文件，如果已经加载过了，则不需要加载
        for (let i = 0; i < menu.length; i++) {
            this.ingestDocument(menu[i], await FsUtil.readFile(path.join('knowledge-data', menu[i])))
        }
    }
}
