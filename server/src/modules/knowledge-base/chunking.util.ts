
export class ChunkingUtil {
    static chunking(text: string, chunkSize: number): string[] {
        // 先对数据进行清理
        let textList = text.replace(/\r\n/g, '\n').replace(/\n{2,}/g, '\n').split('\n');
        textList = textList.map (element => {
            element = element.trim().replace(/\s{2,}/g, ' ');// 去除首位空格
            return element
        });
        textList = textList.filter(e => e !== '')
        let newList: Array<string> = []
        textList.forEach(element => {
            // 这里判断段落的尺寸是不是超过chunkSize，如果超过，则进行分段
            if (element.length > chunkSize) {
                const sentences = element.match(/[^。！？；]+[。！？；]?/g) ?? []
                let buffer = ''
                // 这里再对每个句段进行判断，如果句段的长度超过chunkSize，则按照上限进行分段
                for(const sentence of sentences) {
                    // 情况1：这句自己就超过上限 -> 走硬切兜底
                    if(sentence.length > chunkSize) {
                        // 先把buffer 里攒的切出去 (别忘了已有的包)
                        if(buffer.length > 0) {
                            newList.push(buffer)
                            buffer = ''
                        }
                        // 用正则切分句，碎片全部push
                        const subElements = sentence.match(new RegExp(`.{1,${chunkSize}}`, 'g'))!;
                        newList.push(...subElements);
                        continue
                    }
                    // 情况2：装不下buffer + 这句 -> 切旧包，这句开新包
                    if(buffer.length + sentence.length > chunkSize) {
                       newList.push(buffer)
                       buffer = sentence
                    }else {
                        // 情况3：还装的下 -> 继续攒
                        buffer += sentence;
                    }
                }
                // 如果循环结束，buffer中还有内容，则直接push到newList中
                if(buffer.length > 0) {
                    newList.push(buffer);
                }
            } else {
                newList.push(element);
            }
        });
        return newList;
    }
}