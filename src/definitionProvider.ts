/* eslint-disable curly */
import * as vscode from 'vscode';
import { AngularParser } from './angularParser';
import { FileInfo, SUPPORTED_LANGUAGES } from './types/types';
import { FileUtils } from './utils/FileUtils';

export class DefinitionProvider implements vscode.DefinitionProvider {
    // 缓存配置
    private readonly CACHE_TTL = 5000; // 5秒缓存过期时间
    private readonly MAX_CACHE_SIZE = 1000; // 最大缓存条目数
    private readonly BATCH_SIZE = 10; // 并发处理批次大小

    // 缓存
    private propertyChainCache = new Map<string, { 
        chain: string; 
        timestamp: number;
        references?: vscode.Location[];
    }>();

    // 常用的分隔符和操作符
    private static readonly OPERATORS = new Set([';', '{', '}', '(', ')', '[', ']', ',', ':', '?', '+', '-', '*', '/', '%', '|', '&', '^', '!', '~', '=', '<', '>', '.']);
    private static readonly STRING_DELIMITERS = new Set(['"', "'", '`']);

    constructor(private angularParser: AngularParser) {}

    public async provideDefinition(
        document: vscode.TextDocument,
        position: vscode.Position,        
    ): Promise<vscode.Location | vscode.Location[] | vscode.LocationLink[] | undefined> {
        try {
            const propertyChain = await this.getPropertyChainAtPosition(document, position);
            if (!propertyChain) {
                return undefined;
            }

            const word = propertyChain;
            FileUtils.logDebugForFindDefinitionAndReference(
                `正在查找定义或引用: ${word}, 文件: ${document.fileName}, ` + 
                `位置: ${position.line+1}:${position.character+1}`
            );

            // 检查缓存
            const cacheKey = this.generateCacheKey(document, position, word);
            const cached = this.propertyChainCache.get(cacheKey);
            if (cached?.references && (Date.now() - cached.timestamp) < this.CACHE_TTL) {
                return cached.references;
            }

            const [locations, definitions] = await Promise.all([
                this.findLocationsInCurrentFile(document, word),
                this.findLocationsInAssociatedFiles(document, word)
            ]);

            // 合并结果
            const allLocations = this.mergeAndPrioritizeLocations(document, definitions, locations);

            // 更新缓存
            this.updateCache(cacheKey, allLocations);

            return allLocations.length > 0 ? allLocations : undefined;
        } catch (error) {
            FileUtils.logError(`查找定义时出错: ${error}`, error);
            return undefined;
        }
    }

    private async findLocationsInCurrentFile(
        document: vscode.TextDocument,
        word: string
    ): Promise<vscode.Location[]> {
        const locations: vscode.Location[] = [];
        const definitions: vscode.Location[] = [];

        try {
            const currentFileInfo = this.angularParser.getFileInfo(document.uri.fsPath);
            if (currentFileInfo) {
                this.findLocationsInFileInfo(currentFileInfo, document.uri, word, locations, definitions);
            } else {
                await this.angularParser.parseFile(document.uri);
                const updatedFileInfo = this.angularParser.getFileInfo(document.uri.fsPath);
                if (updatedFileInfo) {
                    this.findLocationsInFileInfo(updatedFileInfo, document.uri, word, locations, definitions);
                }
            }
        } catch (error) {
            FileUtils.logError(`在当前文件中查找位置时出错: ${document.fileName}`, error);
        }

        return [...definitions, ...locations];
    }

    private async findLocationsInAssociatedFiles(
        document: vscode.TextDocument,
        word: string
    ): Promise<vscode.Location[]> {
        const associatedFiles = this.getAssociatedFiles(document);
        const locations: vscode.Location[] = [];
        const definitions: vscode.Location[] = [];

        // 分批处理关联文件
        for (let i = 0; i < associatedFiles.length; i += this.BATCH_SIZE) {
            const batch = associatedFiles.slice(i, i + this.BATCH_SIZE);
            const batchPromises = batch.map(async (file) => {
                try {
                    const tempLocations: vscode.Location[] = [];
                    const tempDefinitions: vscode.Location[] = [];
                    const fileInfo = this.angularParser.getFileInfo(file);
                    const uri = vscode.Uri.file(file);

                    if (fileInfo) {
                        this.findLocationsInFileInfo(fileInfo, uri, word, tempLocations, tempDefinitions);
                    } else {
                        await this.angularParser.parseFile(uri);
                        const updatedFileInfo = this.angularParser.getFileInfo(file);
                        if (updatedFileInfo) {
                            this.findLocationsInFileInfo(updatedFileInfo, uri, word, tempLocations, tempDefinitions);
                        }
                    }

                    return { tempLocations, tempDefinitions };
                } catch (error) {
                    FileUtils.logError(`处理关联文件时出错: ${file}`, error);
                    return { tempLocations: [], tempDefinitions: [] };
                }
            });

            const batchResults = await Promise.all(batchPromises);
            batchResults.forEach(result => {
                locations.push(...result.tempLocations);
                definitions.push(...result.tempDefinitions);
            });
        }

        return [...definitions, ...locations];
    }

    private findLocationsInFileInfo(
        fileInfo: FileInfo, 
        uri: vscode.Uri,
        word: string, 
        locations: vscode.Location[],
        definitions: vscode.Location[]
    ): void {
        try {
            const functionRefs = fileInfo.functions.get(word);
            if (functionRefs) {
                for (const ref of functionRefs) {
                    const location = this.createLocation(fileInfo, uri, ref.position, word);
                    if (ref.isDefinition) {
                        definitions.push(location);
                    } else {
                        locations.push(location);
                    }
                }
            }
        } catch (error) {
            FileUtils.logError(`在文件 ${uri.fsPath} 中查找 ${word} 的位置时出错:`, error);
        }
    }

    private createLocation(fileInfo: FileInfo, uri: vscode.Uri, position: number, word: string): vscode.Location {
        const refPosition = this.angularParser.getPositionLocation(fileInfo.filePath, position);
        return new vscode.Location(uri, new vscode.Range(refPosition, refPosition.translate(0, word.length)));
    }

    private async getPropertyChainAtPosition(
        document: vscode.TextDocument, 
        position: vscode.Position
    ): Promise<string | undefined> {
        try {
            // 获取前后多行内容以处理跨行的属性链
            const range = new vscode.Range(
                new vscode.Position(Math.max(0, position.line - 1), 0),
                new vscode.Position(Math.min(document.lineCount - 1, position.line + 1), Number.MAX_VALUE)
            );
            const surroundingText = document.getText(range);
            
            // 检查是否在注释中
            if (this.isInComment(document, position)) {
                return undefined;
            }

            const wordRange = document.getWordRangeAtPosition(position, /[$a-zA-Z_][$\w]*/);
            if (!wordRange || wordRange.isEmpty) {
                return undefined;
            }

            const cacheKey = this.generateCacheKey(document, position, surroundingText);
            const now = Date.now();
            const cached = this.propertyChainCache.get(cacheKey);
            if (cached && (now - cached.timestamp) < this.CACHE_TTL) {
                return cached.chain;
            }

            const word = document.getText(wordRange);
            const propertyChain = await this.extractPropertyChain(document, position, word);
            
            if (propertyChain) {
                this.updateCache(cacheKey, undefined, propertyChain);
                return propertyChain;
            }

            return word;
        } catch (error) {
            FileUtils.logError('获取属性链时出错:', error);
            return undefined;
        }
    }

    private isInComment(document: vscode.TextDocument, position: vscode.Position): boolean {
        const text = document.lineAt(position.line).text;
        const beforePosition = text.substring(0, position.character);
        
        // 检查是否在字符串中
        let inString = false;
        let stringChar = '';
        for (let i = 0; i < beforePosition.length; i++) {
            if ((beforePosition[i] === '"' || beforePosition[i] === "'") && 
                (i === 0 || beforePosition[i-1] !== '\\')) {
                if (!inString) {
                    inString = true;
                    stringChar = beforePosition[i];
                } else if (beforePosition[i] === stringChar) {
                    inString = false;
                }
            }
        }
        
        // 如果在字符串中，不算作注释
        if (inString) return false;
        
        // 检查是否在行注释中
        if (beforePosition.match(/\/\//)) return true;
        
        // 检查是否在块注释中
        let inBlockComment = false;
        let lineIndex = 0;
        
        while (lineIndex <= position.line) {
            const lineText = document.lineAt(lineIndex).text;
            let startIndex = 0;
            
            while (true) {
                const blockCommentStart = lineText.indexOf('/*', startIndex);
                const blockCommentEnd = lineText.indexOf('*/', startIndex);
                
                if (blockCommentStart === -1 && blockCommentEnd === -1) break;
                
                if (blockCommentStart !== -1 && (blockCommentEnd === -1 || blockCommentStart < blockCommentEnd)) {
                    if (!this.isInString(lineText, blockCommentStart)) {
                        inBlockComment = true;
                    }
                    startIndex = blockCommentStart + 2;
                } else if (blockCommentEnd !== -1) {
                    inBlockComment = false;
                    startIndex = blockCommentEnd + 2;
                }
            }
            
            lineIndex++;
        }
        
        return inBlockComment;
    }

    private isInString(text: string, position: number): boolean {
        let inString = false;
        let stringChar = '';
        
        for (let i = 0; i < position; i++) {
            if ((text[i] === '"' || text[i] === "'") && 
                (i === 0 || text[i-1] !== '\\')) {
                if (!inString) {
                    inString = true;
                    stringChar = text[i];
                } else if (text[i] === stringChar) {
                    inString = false;
                }
            }
        }
        
        return inString;
    }

    private async extractPropertyChain(
        document: vscode.TextDocument,
        position: vscode.Position,
        word: string
    ): Promise<string | undefined> {
        try {
            // 获取前后多行内容以处理跨行的属性链
            const range = new vscode.Range(
                new vscode.Position(Math.max(0, position.line - 1), 0),
                new vscode.Position(Math.min(document.lineCount - 1, position.line + 1), Number.MAX_VALUE)
            );
            const content = document.getText(range);
            const lines = content.split('\n');
            const currentLineIndex = position.line - Math.max(0, position.line - 1);
            
            // 处理当前行之前的内容
            let propertyChain = '';
            let inChain = false;
            let brackets = { round: 0, square: 0, curly: 0 };
            let inString: string | null = null;

            for (let i = currentLineIndex; i >= 0; i--) {
                const line = lines[i];
                const startPos = i === currentLineIndex ? position.character : line.length;
                
                for (let j = startPos - 1; j >= 0; j--) {
                    const char = line[j];
                    
                    // 处理字符串
                    if (DefinitionProvider.STRING_DELIMITERS.has(char)) {
                        if (!this.isEscaped(line, j)) {
                            if (inString === char) {
                                inString = null;
                            } else if (!inString) {
                                inString = char;
                            }
                        }
                        continue;
                    }
                    
                    // 在字符串内部时跳过
                    if (inString) continue;
                    
                    // 处理括号
                    if (this.updateBrackets(char, brackets)) {
                        if (this.hasNegativeBrackets(brackets)) break;
                        continue;
                    }
                    
                    // 处理分隔符
                    if (this.isDelimiter(char, brackets)) {
                        if (!inChain) break;
                        propertyChain = char + propertyChain;
                        continue;
                    }
                    
                    // 处理有效字符
                    if (this.isValidPropertyChar(char)) {
                        inChain = true;
                        propertyChain = char + propertyChain;
                    }
                }
                
                if (!inChain || this.hasNegativeBrackets(brackets)) break;
            }
            
            // 处理当前行之后的内容
            brackets = { round: 0, square: 0, curly: 0 };
            inString = null;
            
            for (let i = currentLineIndex; i < lines.length; i++) {
                const line = lines[i];
                const startPos = i === currentLineIndex ? position.character + word.length : 0;
                
                for (let j = startPos; j < line.length; j++) {
                    const char = line[j];
                    
                    // 处理字符串
                    if (DefinitionProvider.STRING_DELIMITERS.has(char)) {
                        if (!this.isEscaped(line, j)) {
                            if (inString === char) {
                                inString = null;
                            } else if (!inString) {
                                inString = char;
                            }
                        }
                        continue;
                    }
                    
                    // 在字符串内部时跳过
                    if (inString) continue;
                    
                    // 处理括号
                    if (this.updateBrackets(char, brackets)) {
                        if (this.hasNegativeBrackets(brackets)) break;
                        propertyChain += char;
                        continue;
                    }
                    
                    // 处理分隔符
                    if (this.isDelimiter(char, brackets)) {
                        break;
                    }
                    
                    // 处理有效字符
                    if (this.isValidPropertyChar(char)) {
                        propertyChain += char;
                    }
                }
                
                if (this.hasNegativeBrackets(brackets)) break;
            }

            return this.validateAndNormalizeChain(propertyChain);
        } catch (error) {
            FileUtils.logError('获取属性链时出错:', error);
            return undefined;
        }
    }

    private updateBrackets(char: string, brackets: { round: number; square: number; curly: number }): boolean {
        switch (char) {
            case '(': brackets.round--; return true;
            case ')': brackets.round++; return true;
            case '[': brackets.square--; return true;
            case ']': brackets.square++; return true;
            case '{': brackets.curly--; return true;
            case '}': brackets.curly++; return true;
            default: return false;
        }
    }

    private hasNegativeBrackets(brackets: { round: number; square: number; curly: number }): boolean {
        return brackets.round < 0 || brackets.square < 0 || brackets.curly < 0;
    }

    private isDelimiter(char: string, brackets: { round: number; square: number; curly: number }): boolean {
        return (DefinitionProvider.OPERATORS.has(char) && 
                brackets.round === 0 && 
                brackets.square === 0 && 
                brackets.curly === 0);
    }

    private isValidPropertyChar(char: string): boolean {
        return /[a-zA-Z0-9_$.]/.test(char);
    }

    private validateAndNormalizeChain(chain: string): string | undefined {
        if (!this.isValidPropertyChain(chain)) {
            return undefined;
        }

        return this.normalizePropertyChain(chain);
    }

    private isValidPropertyChain(chain: string): boolean {
        return /^[$a-zA-Z_][$\w]*(?:\.[$a-zA-Z_][$\w]*)*$/.test(chain);
    }

    private normalizePropertyChain(chain: string): string {
        if (chain.startsWith('$scope.')) return chain.substring(7);
        if (chain.startsWith('vm.')) return chain.substring(3);
        return chain;
    }

    private isEscaped(str: string, pos: number): boolean {
        let count = 0;
        pos--;
        while (pos >= 0 && str[pos] === '\\') {
            count++;
            pos--;
        }
        return count % 2 === 1;
    }

    private getAssociatedFiles(document: vscode.TextDocument): string[] {
        return document.languageId === SUPPORTED_LANGUAGES.JAVASCRIPT 
            ? this.angularParser.getAssociatedHtmlFiles(document.uri.fsPath)
            : document.languageId === SUPPORTED_LANGUAGES.HTML 
                ? this.angularParser.getAssociatedJsFiles(document.uri.fsPath)
                : [];
    }

    private generateCacheKey(document: vscode.TextDocument, position: vscode.Position, content: string): string {
        const hash = this.hashString(content);
        return `${document.uri.fsPath}:${position.line}:${position.character}:${hash}`;
    }

    private hashString(str: string): string {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash;
        }
        return hash.toString(36);
    }

    private updateCache(
        key: string, 
        references?: vscode.Location[], 
        chain?: string
    ): void {
        const now = Date.now();
        
        // 更新缓存
        if (references !== undefined) {
            this.propertyChainCache.set(key, { references, timestamp: now, chain: '' });
        } else if (chain !== undefined) {
            this.propertyChainCache.set(key, { chain, timestamp: now });
        }

        // 清理过期缓存
        if (this.propertyChainCache.size > this.MAX_CACHE_SIZE) {
            const entries = Array.from(this.propertyChainCache.entries());
            entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
            
            // 删除最旧的条目直到达到目标大小
            const toDelete = entries.slice(0, entries.length - this.MAX_CACHE_SIZE);
            toDelete.forEach(([key]) => this.propertyChainCache.delete(key));
        }
    }

    private mergeAndPrioritizeLocations(
        document: vscode.TextDocument,
        definitions: vscode.Location[],
        locations: vscode.Location[]
    ): vscode.Location[] {
        // 如果在 HTML 文件中且有定义，优先返回定义
        if (document.languageId === SUPPORTED_LANGUAGES.HTML && definitions.length > 0) {
            return [definitions[0]];
        }

        // 否则返回所有位置，定义在前
        return [...definitions, ...locations];
    }
}
