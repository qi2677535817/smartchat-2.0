
export class ChunkingUtil {
    static chunking(text: string, chunkSize: number): string[] {
        let chunks: string[] = [];
        // 先对数据进行清理
        const textList = text.replace(/\n{2,}/g, '\n').split('\n');
        textList.map(element => {
            element = element.trim();// 去除首位空格
            element = element.replace(/\s{2,}/, ' '); // 去除多余空格
        });
        let newList: Array<string> = []
        textList.map(element => {
            if (element.length > chunkSize) {
                const subElements = element.match(new RegExp(`.{1,${chunkSize}}`, 'g'))!;
                newList.push(...subElements);
            } else {
                newList.push(element);
            }
        });
        chunks = [...newList]
        return chunks;
    }
}