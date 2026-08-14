import { Injectable, OnModuleInit  } from "@nestjs/common";
import { EmbeddingService } from "../embedding/embedding.service";
import { ChunkingUtil } from "./chunking.util"; 

@Injectable()
export class KnowledgeBaseService implements OnModuleInit{
    constructor( private readonly embeddingService: EmbeddingService) {
    }
    private chunks: {
        content: number[][],
        text: string
    }[] = []
    // 向量比对相似度
    async compareSimilarity(query: string, documents: number[][]): Promise<number[]> {
        let parameter1 = await this.embeddingService.embedText(query)
        let cosineSimilarityList: number[] = []
        for(let j = 0; j < documents.length; j++) {
            let sumSql1 = 0
            let sumSql2 = 0
            let dot1 = 0
            for (let i = 0; i < parameter1.length; i++) {
                dot1 += parameter1[i] * documents[j][i]
                sumSql1 += parameter1[i] * parameter1[i]
                sumSql2 += documents[j][i] * documents[j][i]
            }
            let cosineSimilarity = dot1 / (Math.sqrt(sumSql1) * Math.sqrt(sumSql2))
            cosineSimilarityList.push(cosineSimilarity)
        }
        return cosineSimilarityList
    }
    async addDocument(document: string[]) {
        let list: number[][] = []
        if(document.length > 0) {
            // TODO: 实现文档添加逻辑
            for(let i = 0; i < document.length; i++) {
                let parameter = await this.embeddingService.embedText(document[i])
                list.push(parameter)
            }
        }
        return list
    }
    async onModuleInit() {
        let text1 = `合肥今日中雨，局部大雨伴雷风，气温23～26℃，东北风3—4级。 体感偏凉湿润，不宜跑步、登山等户外锻炼，建议改室内活动；必要外出带伞穿防滑鞋，躲开积水与广告牌，雷暴时勿近大树河道`
        let text2 = `牛油红汤最够味，厚切吊龙、毛肚七上八下，鸭肠烫到微卷，吸饱辣油一口爆香。想解腻就加份贡菜和笋片，脆爽刮油。番茄汤底酸甜开胃，涮嫩牛肉和虾滑最配，连汤都能喝两碗。蘸料各有所爱：重口党蒜泥+香油+蚝油+小米辣，辣得通透；清爽派就麻酱+韭菜花+腐乳，裹宽粉一绝。最后记得来份冰粉或酸梅汤，热气散尽，才算圆满`
        let text3 = `变量是代码的容器，起名要见名知意，别用 a、b、tmp 糊弄自己，类型搞清楚，该用常量就用 const。函数是把重复逻辑打包，一个函数只干一件事，参数别塞七八个，复杂了就拆。调试别只会 print，学会下断点看调用栈；遇到怪问题，先怀疑数据，再怀疑逻辑，最后才怀疑环境。最实用的技巧：改一行测一行，别堆一百行再跑；出错了先读报错信息，而不是盯着代码发呆。写好注释，三个月后的你，会感谢现在的你。`
        let p1 = ChunkingUtil.chunking(text1, 50)
        let p2 = ChunkingUtil.chunking(text2, 50)
        let p3 = ChunkingUtil.chunking(text3, 50)
        let em1 = await this.addDocument(p1)
        let em2 = await this.addDocument(p2)
        let em3 = await this.addDocument(p3)
        this.chunks.push({
            text: text1,
            content: em1
        })
         this.chunks.push({
            text: text2,
            content: em2
        })
         this.chunks.push({
            text: text3,
            content: em3
        })
        for(let i = 0; i < this.chunks.length; i++) {
            let num = await this.compareSimilarity('今天天气咋样', this.chunks[i].content)
            console.log(num);
            
        }
    }
}
