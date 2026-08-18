import * as fs from 'fs/promises'
export class FsUtil {

    static path = require('path')
    /**
     * 读取目录
     * @param url 
     * @returns 
     */
    static readMenu(url: string) {
        let _url = this.path.join(process.cwd(), url)
        return fs.readdir(_url)
    }
    /**
     * 读取文件
     */
    static readFile(url: string) {
        let _url = this.path.join(process.cwd(), url)
        return fs.readFile(_url, 'utf8')
    }
    /**
     * 写入文件
     */
    static writeFile(url: string, data: string) {
        let _url = this.path.join(process.cwd(), url)
        return fs.writeFile(_url, data, 'utf8')
    }
}