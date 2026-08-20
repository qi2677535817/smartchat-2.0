import { Injectable, OnModuleInit, Logger } from "@nestjs/common";
import { EmbeddingService } from "../embedding/embedding.service";
import { ChunkingUtil } from "./chunking.util";
import { FsUtil } from "./fs.util";
import path from "node:path";
import { concatWith } from "rxjs";


type Chunk = {
    vector: number[],
    text: string,
    index?: number,
    name: string,
    mtime?: string
}
type Meta = Record<string, number>

@Injectable()
export class KnowledgeBaseService implements OnModuleInit {
    constructor(private readonly embeddingService: EmbeddingService) {
    }
    private readonly logger = new Logger(KnowledgeBaseService.name)

    private chunks: {
        meta: Meta
        chunks: Chunk[]
    } = {
            meta: {},
            chunks: []
        }
    private test_chunks: {
        meta: Meta
        chunks: Chunk[]
    } = {
            meta: {},
            chunks: []
        }
    /**
     * 检查本地RAG
     * @param query 
     * @returns 
     */
    async searchRag(query: string, isTest: boolean = false): Promise<{
        score: number,
        index: number,
        content: string,
        name: string
    }[]> {
        let similarity = await this.compareSimilarity(query, isTest)
        // 这里设置对比阈值为0.5， topk为3
        let topkList: any[] = []
        if (similarity.length > 0) {
            for (let i = 0; i < similarity.length; i++) {
                if (similarity[i].score > 0.5) {
                    topkList.push(similarity[i])
                }
            }
            topkList = topkList.sort((a, b) => b.score - a.score)
            topkList = topkList.length > 3 ? topkList.slice(0, 3) : topkList
        }
        return topkList
    }
    // 向量比对相似度
    async compareSimilarity(query: string, isTest: boolean = false): Promise<{
        score: number,
        index: number,
        content: string,
        name: string
    }[]> {
        let _chunks = this.chunks
        if (isTest) {
            _chunks = this.test_chunks
        }
        if (_chunks.chunks.length === 0) {
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
        for (let k = 0; k < _chunks.chunks.length; k++) {
            let dot1 = 0
            let sumSql1 = 0
            let sumSql2 = 0
            for (let i = 0; i < parameter1.length; i++) {
                dot1 += parameter1[i] * _chunks[k].vector[i]
                sumSql1 += parameter1[i] * parameter1[i]
                sumSql2 += _chunks[k].vector[i] * _chunks[k].vector[i]
            }
            let cosineSimilarity = dot1 / (Math.sqrt(sumSql1) * Math.sqrt(sumSql2))
            cosineSimilarityList.push({
                score: cosineSimilarity,
                index: _chunks[k].index!,
                content: _chunks[k].text,
                name: _chunks[k].name
            })
        }
        return cosineSimilarityList
    }
    /**
     * 清洗数据 + 转化向量
     * @param document 文档内容数组
     * @returns 嵌入向量数组
     */
    async addDocument(name: string, content: string, chunking: number = 200) {
        let list: Chunk[] = []
        let document: string[] = []
        // 先对内容进行分块
        if (content.length > 0) {
            document = ChunkingUtil.chunking(content, chunking)
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
     * 同名检查 + 修改时间检查
     */
    async ingestDocument(name: string, content: string, mtime: number, chunking: number = 200) {
        let files: Chunk[] = [] // 初始化文件
        let embeddingData: {
            meta: Meta,
            chunks: Chunk[]
        } = {
            meta: {},
            chunks: []
        } // 初始化向量数据

        try {
            // 获取向量文件中已加载的数据列表
            embeddingData = JSON.parse(await FsUtil.readFile(path.join('data-cache', 'knowledge-vectors.json')))
        } catch (e) {
            this.logger.error('读取向量文件失败: ' + e)
        }
        // 将整理后的向量数据写入文件
        files.push(...await this.addDocument(name, content, chunking))
        //  ----------------------- 写入 ---------------------------------------
        embeddingData.meta[name] = mtime
        // 其实这里也要检查，如果是更新内容的话就直接替换对应内容
        if(embeddingData.chunks.some(e => e.name == name)) {
            embeddingData.chunks = embeddingData.chunks.filter(item => item.name !== name)
        }
        embeddingData.chunks = [...embeddingData.chunks, ...files]
        await FsUtil.writeFile(path.join('data-cache', 'knowledge-vectors.json'), JSON.stringify(embeddingData, null, 2))
        this.chunks = embeddingData
        return { msg: "文件存入成功", code: 0 }
    }
    async initRag(chunking: number = 200) {
        // 读取目录
        let menu = await FsUtil.readMenu('knowledge-data')
        let ragData: {
            meta: Meta,
            chunks: Chunk[]
        } = {
            meta: {},
            chunks: []
        };
        try {
            ragData = JSON.parse(await FsUtil.readFile(path.join('data-cache', 'knowledge-vectors.json')))
        } catch (e) {
            this.logger.error('读取向量文件失败1:' + e)
        }
        // 依次获取目录文件的元数据
        for (const fileName of menu) {
            let meta = await FsUtil.getFileMeta(path.join('knowledge-data', fileName))
            let content = await FsUtil.readFile(path.join('knowledge-data', fileName))
            // 如果向量数据库为空则直接开始后续清洗 + 转化 + 写入流程
            if (!ragData || ragData.chunks.length == 0) {
                await this.ingestDocument(fileName, content, meta.mtimeMs, chunking)
            } else {
                // 这里去判断缓存数据中的修改时间和文件修改时间是否一致
                if (ragData.meta[fileName] !== meta.mtimeMs) {
                    // 如果不一致，说明文件内有改动，更新向量数据库
                    await this.ingestDocument(fileName, content, meta.mtimeMs, chunking)
                } else {
                    // 如果修改时间一致，再检查同名
                    if (ragData.chunks.some(item => item.name == fileName)) {
                        await this.ingestDocument(fileName, content, meta.mtimeMs, chunking)
                    }
                }
            }
        }
    }
    // 测试专用
    async testInitRag(chunking: number = 200) {
        this.test_chunks = {
            meta: {},
            chunks: []
        }
        // 读取目录
        let menu = await FsUtil.readMenu('knowledge-data')
        // 循环加载目录中的文件，如果已经加载过了，则不需要加载
        for (let i = 0; i < menu.length; i++) {
            let name = menu[i]
            let content = await FsUtil.readFile(path.join('knowledge-data', menu[i]))
            let files: Chunk[] = [] // 初始化文件

            // 将传入文件内容存入向量数据库，同时写入向量数据库
            files.push(...await this.addDocument(name, content, chunking))
            await FsUtil.writeFile(path.join('data-cache', 'knowledge-base.json'), JSON.stringify([...this.test_chunks.chunks, ...files], null, 2))
            this.test_chunks.chunks = [...this.test_chunks.chunks, ...files]
        }
    }
    async onModuleInit() {
       this.initRag()
    }
}
