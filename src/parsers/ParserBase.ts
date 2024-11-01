export abstract class ParserBase {
    protected parsingFiles: Set<string> = new Set();
    
    public isFileBeingParsed(filePath: string): boolean {
        return this.parsingFiles.has(filePath);
    }
    
    protected markFileAsParsing(filePath: string): void {
        this.parsingFiles.add(filePath);
    }
    
    protected markFileAsFinishedParsing(filePath: string): void {
        this.parsingFiles.delete(filePath);
    }
} 