import { KnowledgeBaseService } from "./knowledge-base.service"
import { Injectable } from "@nestjs/common"

@Injectable()
export class testFunction {
    constructor( private readonly knowledgeBaseService: KnowledgeBaseService ) {

    }
    private questions = [
        {
            question: '毛肚要涮多久',
            expect: '火锅资料.md',
        },
        {
            question: '什么是函数',
            expect: '编程资料.md'
        },
        {
            question: '什么是变量',
            expect: '编程资料.md'
        },
        {
            question: '天气怎么样',
            expect: '天气资料.md',
        },
        {
            question: '今天推荐哪些活动',
            expect: '天气资料.md',
        },
        {
            question: '下雨天推荐什么室内活动',
            expect: '天气资料.md',
        },
        // {
        //     question: '牛百叶七上八下是什么梗',
        //     expect: '天气资料.md',
        // },
        // {
        //     question: '今天气温多少度？适合穿什么衣服',
        //     expect: '天气资料.md',
        // },
        // {
        //     question: '代码怎么调试',
        //     expect: '编程资料.md',
        // },
        // {
        //     question: '量子力学是什么',
        //     expect: '编程.md',
        // },
        // {
        //     question: '怎么制作冰粉',
        //     expect: '火锅资料.md',
        // },
        // {
        //     question: '想吃开胃的火锅，有什么推荐的？',
        //     expect: '火锅资料.md',
        // }
    ]

    async test(): Promise<number[]> {
        // 分别测试不同的分块策略，分别为100/200/400 三档，threshold 和 topK 固定为0.5 和 3
        let spList = [50, 200, 400]
        let numList: number[] = []
        for(let sp of spList) {
            await this.knowledgeBaseService.testInitRag(sp)
            let num = 0
            // 循环问题测试结果
            for(let q of this.questions) {
                // 这里获取了每个问题的最相似的前三个回复内容
                let result = await this.knowledgeBaseService.searchRag(q.question, true)
                num += result.some(item => item.name === q.expect)? 1: 0
                // let newRes = JSON.stringify(result.map(r => { return { name:r.name, score:r.score}})) 
                console.log(`chunking：${sp}，
                    问题：${q.question}，
                    期望：${q.expect}，
                    实际：${JSON.stringify(result)}`)
            }
            numList.push(num)
            console.log(`本轮命中: ${num} / ${this.questions.length}个问题`);
            
        }
        return numList
    }
}