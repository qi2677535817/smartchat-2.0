import { BadRequestException, Injectable, OnModuleInit, Logger } from "@nestjs/common";
import { EmbeddingService } from "../embedding/embedding.service";
import { ChunkingUtil } from "./chunking.util";
import { FsUtil } from "./fs.util";
import path, { join } from "node:path";
import { RerankService } from "../embedding/rerank.service";
import { ConfigService } from "@nestjs/config";


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
    private readonly RERANK_ENABLED; // 控制开关

    constructor(private readonly embeddingService: EmbeddingService,
        private readonly rerankService: RerankService,
        private readonly configService: ConfigService
    ) {
        this.RERANK_ENABLED = this.configService.get('RERANK_ENABLED') === 'true'
        this.logger.log('RERANK_ENABLED = ' + this.RERANK_ENABLED)
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
     * 返回向量数据库数据
     */
    async getRagData(): Promise<{
        name: string,
        mtime: number,
        chunkCount: number
    }[]> {
        // 读取rag数据
        let rag: {
            meta: Meta,
            chunks: Chunk[]
        } = JSON.parse(await FsUtil.readFile(path.join('data-cache', 'knowledge-vectors.json')))
        // 处理rag数据按照要求返回
        let newRag = Object.entries(rag.meta).map(([key, val]) => {
            const count = rag.chunks.reduce((total, item) => {
                return item.name == key ? total + 1 : total
            }, 0)
            return {
                name: key,
                mtime: val,
                chunkCount: count
            }
        })
        return newRag
    }
    /**
     * 删除向量数据库
     */
    async deleteRagData(name: string) {
        // 首先先判断传入的文件名称在源数据中是否存在
        try {
            let ragData = JSON.parse(await FsUtil.readFile(join('data-cache', 'knowledge-vectors.json')))
            if (ragData.meta[name]) {
                // 元数据中有记录文件名称则同时删除源文件和数据库中的相关数据W
                // 先过滤掉元数据中相关数据
                ragData.chunks = ragData.chunks.filter(item => item.name !== name)
                delete ragData.meta[name]
                await FsUtil.writeFile(join('data-cache', 'knowledge-vectors.json'), JSON.stringify(ragData, null, 2))
                this.chunks = ragData
                try {
                    await FsUtil.unlinkFile(join('knowledge-data', name))
                    return { code: 0, msg: "删除成功" }
                } catch (e) {
                    if (e instanceof Error && (e as NodeJS.ErrnoException).code === 'ENOENT') {
                        return { code: 0, msg: '删除成功' }
                    }
                    return { code: -1, msg: '删除失败' }
                }

            }
        } catch (e) {
            return { code: -1, msg: "删除失败" }
        }
    }
    /**
     * 检查本地RAG
     * @param query 
     * @returns 
     */
    async searchRag(query: string, isTest: boolean = false, extraChunks: Chunk[] = []): Promise<{
        score: number,
        index: number,
        content: string,
        name: string
    }[]> {
        // 粗召编排数据（extraChunks 为会话附件等额外候选，与全局库一起检索）
        let similarity = await this.compareSimilarity(query, isTest, extraChunks)
        // 1.0: 这里设置对比阈值为0.5， topk为3, 
        // 2.0: 精排后的数据不需要再取阈值了，这里暂定去topk 为 3
        let topkList: any[] = []
        if (!this.RERANK_ENABLED) {
            for (let i = 0; i < similarity.length; i++) {
                if (similarity[i].score > 0.5) {
                    topkList.push(similarity[i])
                }
            }
            topkList = topkList.sort((a, b) => b.score - a.score)
            topkList = topkList.length > 3 ? topkList.slice(0, 3) : topkList
        } else {
            // 重新整理候选集数据，按照排序模型请求的指定格式
            similarity = similarity.sort((a, b) => b.score - a.score)
            similarity = similarity.slice(0, 15)
            let newLis = similarity.map(item => item.content)
            this.logger.log(`召回候选: ${newLis.length} 个, ${similarity.slice(0, 15).map(s => s.name).join(',')}`)

            // 候选集为空时直接返回，避免空列表请求精排接口被 400 拒绝后抛错导致进程崩溃
            if (newLis.length === 0) {
                return []
            }

            // 这里对召回向量的候选集进行交叉编码精排
            const rerankRes = await this.rerankService.getRerankList(query, newLis)
            topkList = rerankRes.slice(0, 3).map(r => similarity[r.index])   // 用下标找回完整候选
        }

        return topkList
    }
    // 向量比对相似度（全局 chunks + extraChunks 合并检索）
    async compareSimilarity(query: string, isTest: boolean = false, extraChunks: Chunk[] = []): Promise<{
        score: number,
        index: number,
        content: string,
        name: string
    }[]> {
        let _chunks = this.chunks
        if (isTest) {
            _chunks = this.test_chunks
        }
        const allChunks: Chunk[] = [..._chunks.chunks, ...extraChunks]
        if (allChunks.length === 0) {
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
        for (let k = 0; k < allChunks.length; k++) {
            let dot1 = 0
            let sumSql1 = 0
            let sumSql2 = 0
            for (let i = 0; i < parameter1.length; i++) {
                dot1 += parameter1[i] * allChunks[k].vector[i]
                sumSql1 += parameter1[i] * parameter1[i]
                sumSql2 += allChunks[k].vector[i] * allChunks[k].vector[i]
            }
            let cosineSimilarity = dot1 / (Math.sqrt(sumSql1) * Math.sqrt(sumSql2))
            cosineSimilarityList.push({
                score: cosineSimilarity,
                index: allChunks[k].index ?? k,
                content: allChunks[k].text,
                name: allChunks[k].name
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
     * 入库前校验：仅接受文本内容，防止二进制/乱码（如 PDF 被误读）导致海量无效分块与向量库膨胀
     */
    private assertTextContent(name: string, content: string, chunking: number) {
        // 单文档体积上限（约 2MB 文本）
        const MAX_BYTES = 2 * 1024 * 1024
        if (Buffer.byteLength(content, 'utf8') > MAX_BYTES) {
            throw new BadRequestException(`文档过大（超过 ${MAX_BYTES / 1024 / 1024}MB），请拆分后上传`)
        }
        // 乱码检测：替换字符 U+FFFD 或异常控制字符占比过高即判定为二进制内容
        let suspicious = 0
        for (const ch of content) {
            const code = ch.codePointAt(0)!
            if (code === 0xfffd || (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d)) {
                suspicious++
            }
        }
        const ratio = content.length > 0 ? suspicious / content.length : 0
        if (ratio > 0.02) {
            throw new BadRequestException('检测到二进制或乱码内容：知识库仅支持文本文件（.txt/.md），PDF 请先转成文本')
        }
        // 分块数量上限：防止超长文档触发海量 embedding 请求
        const chunkCount = Math.ceil(content.length / chunking)
        if (chunkCount > 1000) {
            throw new BadRequestException(`文档分块过多（${chunkCount} 块），请精简后上传`)
        }
    }

    /**
     * 同名检查 + 修改时间检查
     */
    async ingestDocument(name: string, content: string, mtime: number, chunking: number = 200) {
        this.assertTextContent(name, content, chunking)
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
        // 这里判断文件是新增还是更新
        let isNew = false
        if (!embeddingData.meta[name]) isNew = true // 表示为新增
        // 将整理后的向量数据写入文件
        files.push(...await this.addDocument(name, content, chunking))
        //  ----------------------- 写入 ---------------------------------------
        embeddingData.meta[name] = mtime
        // 其实这里也要检查，如果是更新内容的话就直接替换对应内容
        if (embeddingData.chunks.some(e => e.name == name)) {
            embeddingData.chunks = embeddingData.chunks.filter(item => item.name !== name)
        }
        embeddingData.chunks = [...embeddingData.chunks, ...files]
        await FsUtil.writeFile(path.join('data-cache', 'knowledge-vectors.json'), JSON.stringify(embeddingData, null, 2))
        // 需要判断下是否为传入新增文件
        if (isNew) {
            await FsUtil.writeFile(path.join('knowledge-data', name), content)
        }
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
                    // mtime 一致且向量库已有该文件 -> 内容未变更，跳过避免重复入库
                    this.logger.log(`跳过未变更文件: ${fileName}`)
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
