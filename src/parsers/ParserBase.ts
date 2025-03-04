export class ParserBase {
    protected parsingFiles = new Set<string>();
    
    /**
     * 检查文件是否正在被解析
     * @param filePath 文件路径
     * @returns 如果文件正在被解析则返回 true，否则返回 false
     */
    public isFileBeingParsed(filePath: string): boolean {
        return this.parsingFiles.has(filePath);
    }
    
    /**
     * 标记文件开始解析
     * @param filePath 文件路径
     */
    protected markFileAsParsing(filePath: string): void {
        this.parsingFiles.add(filePath);
    }
    
    /**
     * 标记文件完成解析
     * @param filePath 文件路径
     */
    protected markFileAsFinishedParsing(filePath: string): void {
        this.parsingFiles.delete(filePath);
    }
} 