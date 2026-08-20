import { ChunkingUtil } from './chunking.util';

describe('ChunkingUtil.chunking', () => {
    it('多个连续空行应折叠成一个', () => {
        const input = '第一段内容\n\n\n\n第二段内容'
        const result = ChunkingUtil.chunking(input, 50)
        expect(result).toEqual(['第一段内容', '第二段内容'])
    })
    it('\r\n换行符应转换为\n', () => {
        const input = '第一段内容\r\n\r\n第二段内容'
        const result = ChunkingUtil.chunking(input, 50)
        expect(result).toEqual(['第一段内容', '第二段内容'])
    })
    it('连续空格应合并为一个空格', () => {
        const input = '第一段内容        第二段内容'
        const result = ChunkingUtil.chunking(input, 50)
        expect(result).toEqual(['第一段内容 第二段内容'])
    })
    it('中文分句超长句子应该按照传入chunkSize硬切', () => {
        const input = '一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十'
        const result = ChunkingUtil.chunking(input, 10)
        expect(result).toEqual([
            '一二三四五六七八九十',
            '一二三四五六七八九十',
            '一二三四五六七八九十'
        ])
    })
    it('多句累积打包：总长不超过上限、跨过上限时切新块、结尾尾巴保留', () => {
        const input = `今天天气很好适合出门散步。晚上我们去吃火锅。火锅要涮毛肚和鸭肠。最后再来一份冰粉解辣。`
        const result = ChunkingUtil.chunking(input, 20)
        expect(result).toEqual([
            '今天天气很好适合出门散步。',
            '晚上我们去吃火锅。火锅要涮毛肚和鸭肠。',
            '最后再来一份冰粉解辣。'
        ])
        expect(result.every(c => c.length <= 20)).toBe(true)
    })
})