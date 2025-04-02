/* eslint-disable curly */
import * as vscode from 'vscode';
import { FileInfo } from '../types/types';
import { FileInfoFactory } from '../utils/FileInfoFactory';
import { FileUtils } from '../utils/FileUtils';
import { PathResolver } from '../utils/PathResolver';
import { JavaScriptParser } from './JavaScriptParser';
import { ParserBase } from './ParserBase';

export class HtmlParser extends ParserBase {
    // 配置常量
    private readonly PARSE_CHUNK_SIZE = 50000; // 50KB 的块大小
    private readonly CACHE_TTL = 30000; // 30秒缓存过期时间
    private readonly MAX_CACHE_SIZE = 100; // 最大缓存条目数

    // 预编译的正则表达式
    private static readonly COMPILED_REGEXES = {
        scriptSrc: new RegExp(/<script(?=[\s>])(?:(?!(?:src\s*=\s*['"]|>))[^>])*src\s*=\s*['"]([^'"]+)['"][^>]*>/g),
        ngDirective: new RegExp(/ng-(\w+)\s*=\s*["'](.+?)["']/g),
        functionName: new RegExp(/\b([a-zA-Z_$][a-zA-Z0-9_$]*)(?:\s*\(|\s*&&|\s*\|\||\s*\?|\s*:|\s*$)/g),
        inlineScript: new RegExp(/<script(?![^>]*src=)([^>]*)>([\s\S]*?)<\/script>/g),
        expression: new RegExp(/{{(.+?)}}/g),
        ngBind: new RegExp(/ng-bind(?:-html)?\s*=\s*["']([^"']+)["']/g),
        directive: new RegExp(/ng-(if|show|hide|repeat|model|class|style)\s*=\s*["']((?:\{.+?\})|(?:.+?))["']/g),
        filter: new RegExp(/\|\s*(\w+)/g),
        scopeVar: new RegExp(/\$scope\.([a-zA-Z_$][a-zA-Z0-9_$]*)/g)
    };


    // 缓存
    private parseResultCache = new Map<string, {
        fileInfo: FileInfo;
        associatedJsFiles: string[];
        timestamp: number;
        hash: string;
    }>();

    // 缓存常用的忽略列表
    private static readonly IGNORE_LIST = new Set([
        'undefined', 'null', 'true', 'false',
        'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break',
        'continue', 'return', 'try', 'catch', 'finally', 'throw',
        'var', 'let', 'const',
        'function', 'class',
        'this', 'super',
        'Object', 'Array', 'String', 'Number', 'Boolean', 'Function',
        'Math', 'Date', 'RegExp', 'Error', 'JSON'
    ]);

    constructor(
        private pathResolver: PathResolver,
        private jsParser: JavaScriptParser = new JavaScriptParser()
    ) {
        super();
    }

    public async parseHtmlFile(document: vscode.TextDocument): Promise<{ fileInfo: FileInfo, associatedJsFiles: string[] }> {
        const filePath = document.uri.fsPath;
        if (this.isFileBeingParsed(filePath)) {
            FileUtils.logDebugForAssociations(`跳过正在解析的HTML文件: ${filePath}`);
            return { fileInfo: FileInfoFactory.createEmpty(filePath), associatedJsFiles: [] };
        }

        this.markFileAsParsing(filePath);
        try {
            const content = document.getText();
            const contentHash = this.hashContent(content);

            // 检查缓存
            const cached = this.parseResultCache.get(filePath);
            if (cached && cached.hash === contentHash && (Date.now() - cached.timestamp) < this.CACHE_TTL) {
                FileUtils.logDebugForAssociations(`使用缓存的解析结果: ${filePath}`);
                return {
                    fileInfo: cached.fileInfo,
                    associatedJsFiles: cached.associatedJsFiles
                };
            }

            const fileInfo = FileInfoFactory.createEmpty(filePath);

            // 并行处理不同的解析任务
            const [associatedJsFiles, ngAttributesPromise, inlineJsPromise, expressionsPromise] = await Promise.all([
                this.parseHtmlForJsFiles(document),
                this.parseNgAttributesAsync(document, content, fileInfo),
                this.parseInlineJavaScriptAsync(document, content, fileInfo),
                this.parseAngularExpressionsAsync(document, content, fileInfo)
            ]);

            // 等待所有异步任务完成
            await Promise.all([ngAttributesPromise, inlineJsPromise, expressionsPromise]);

            // 更新缓存
            this.updateCache(filePath, fileInfo, associatedJsFiles, contentHash);

            FileUtils.logDebugForAssociations(`HTML文件 ${filePath} 解析完成，关联的JS文件: ${associatedJsFiles.join(', ')}`);
            return { fileInfo, associatedJsFiles };
        } finally {
            this.markFileAsFinishedParsing(filePath);
        }
    }

    public async parseHtmlForJsFiles(document: vscode.TextDocument): Promise<string[]> {
        FileUtils.logDebugForAssociations(`开始解析HTML文件以查找关联的JS文件: ${document.uri.fsPath}`);
        const content = document.getText();
        const jsFiles = new Set<string>();

        // 重置正则表达式的 lastIndex
        HtmlParser.COMPILED_REGEXES.scriptSrc.lastIndex = 0;
        
        let match;
        while ((match = HtmlParser.COMPILED_REGEXES.scriptSrc.exec(content)) !== null) {
            const scriptSrc = match[1];
            FileUtils.logDebugForAssociations(`找到script标签，src属性值: ${scriptSrc}`);
            const resolvedPath = this.pathResolver.resolveScriptPath(scriptSrc, document.uri);
            if (resolvedPath) {
                FileUtils.logDebugForAssociations(`解析后的JS文件路径: ${resolvedPath.fsPath}`);
                jsFiles.add(resolvedPath.fsPath);
            }
        }

        return Array.from(jsFiles);
    }

    public async parseHtmlFileAssociations(document: vscode.TextDocument): Promise<{ associatedJsFiles: string[] }> {
        FileUtils.logDebugForAssociations(`快速解析HTML文件关联: ${document.uri.fsPath}`);
        const associatedJsFiles = await this.parseHtmlForJsFiles(document);
        return { associatedJsFiles };
    }

    private async parseNgAttributesAsync(document: vscode.TextDocument, content: string, fileInfo: FileInfo): Promise<void> {
        return new Promise<void>((resolve) => {
            HtmlParser.COMPILED_REGEXES.ngDirective.lastIndex = 0;
        let match;
            while ((match = HtmlParser.COMPILED_REGEXES.ngDirective.exec(content)) !== null) {
            const directive = match[1];
            const value = match[2];
            
            this.extractFunctionReferences(document, value, fileInfo, match.index + match[0].indexOf(value));
            
            fileInfo.ngAttributes.set(directive, {
                name: directive,
                position: document.offsetAt(document.positionAt(match.index)),
                type: 'ngAttribute',
                value: value,
                isDefinition: false
            });
        }
            resolve();
        });
    }

    private extractFunctionReferences(document: vscode.TextDocument, value: string, fileInfo: FileInfo, startIndex: number): void {
        HtmlParser.COMPILED_REGEXES.functionName.lastIndex = 0;
        let functionMatch;
        while ((functionMatch = HtmlParser.COMPILED_REGEXES.functionName.exec(value)) !== null) {
            const functionName = functionMatch[1];
            // 忽略数字和 JavaScript 关键字
            if (!this.shouldIgnoreReference(functionName)) {
                const position = document.offsetAt(document.positionAt(startIndex + functionMatch.index));
                this.addFunctionToFileInfo(fileInfo, functionName, position, false);
                FileUtils.logDebugForFindDefinitionAndReference(
                    `在HTML中找到函数引用: ${functionName}, 位置: ${document.uri.fsPath}, ` +
                    `行 ${document.positionAt(position).line + 1}, ` +
                    `列 ${document.positionAt(position).character + 1}`
                );
            }
        }
    }

    private shouldIgnoreReference(name: string): boolean {
        // 忽略数字
        if (/^\d+$/.test(name)) return true;
        // 使用 Set 提高查找性能
        return HtmlParser.IGNORE_LIST.has(name);
    }

    private async parseInlineJavaScriptAsync(document: vscode.TextDocument, content: string, fileInfo: FileInfo): Promise<void> {
        const scriptMatches = content.match(/<script[^>]*>([\s\S]*?)<\/script>/g);
        if (!scriptMatches) return;

        for (const match of scriptMatches) {
            const scriptContent = match.replace(/<script[^>]*>|<\/script>/g, '').trim();
            if (!scriptContent) continue;

            await this.jsParser.parseJavaScriptContent(scriptContent, fileInfo, document);
        }
    }

    private async parseAngularExpressionsAsync(document: vscode.TextDocument, content: string, fileInfo: FileInfo): Promise<void> {
        return new Promise<void>((resolve) => {
            // 分块处理大文件
            const chunks = this.splitIntoChunks(content);
            let offset = 0;

            for (const chunk of chunks) {
                // 解析表达式
                this.parseExpressionInChunk(document, chunk, fileInfo, offset);
                offset += chunk.length;
            }

            resolve();
        });
    }

    private parseExpressionInChunk(document: vscode.TextDocument, chunk: string, fileInfo: FileInfo, offset: number): void {
        // 解析 {{expression}}
        this.parseRegexInChunk(HtmlParser.COMPILED_REGEXES.expression, chunk, offset, (match, startIndex) => {
            const expression = match[1];
            this.processExpression(document, expression, fileInfo, startIndex + 2);
        });

        // 解析 ng-bind
        this.parseRegexInChunk(HtmlParser.COMPILED_REGEXES.ngBind, chunk, offset, (match, startIndex) => {
            const expression = match[1];
            this.processExpression(document, expression, fileInfo, startIndex + match[0].indexOf(expression));
        });

        // 解析 ng-* 指令
        this.parseRegexInChunk(HtmlParser.COMPILED_REGEXES.directive, chunk, offset, (match, startIndex) => {
            const expression = match[2];
            if (expression.startsWith('{') && expression.endsWith('}')) {
                this.processExpression(document, expression.slice(1, -1), fileInfo, startIndex + match[0].indexOf(expression) + 1);
            } else {
                this.processExpression(document, expression, fileInfo, startIndex + match[0].indexOf(expression));
            }
        });
    }

    private parseRegexInChunk(regex: RegExp, chunk: string, offset: number, processor: (match: RegExpExecArray, startIndex: number) => void): void {
        regex.lastIndex = 0;
        let match;
        while ((match = regex.exec(chunk)) !== null) {
            processor(match, match.index + offset);
        }
    }

    private processExpression(document: vscode.TextDocument, expression: string, fileInfo: FileInfo, startIndex: number): void {
            this.extractFunctionReferences(document, expression, fileInfo, startIndex);
            this.extractScopeReferences(document, expression, fileInfo, startIndex);
            this.extractFilterReferences(document, expression, fileInfo, startIndex);
        }

    private splitIntoChunks(content: string): string[] {
        const chunks: string[] = [];
        let lastTagEnd = 0;
        let currentPosition = 0;
        
        while (currentPosition < content.length) {
            const nextChunkEnd = this.findSafeChunkBoundary(
                content,
                currentPosition,
                Math.min(currentPosition + this.PARSE_CHUNK_SIZE, content.length)
            );
            
            chunks.push(content.slice(lastTagEnd, nextChunkEnd));
            lastTagEnd = nextChunkEnd;
            currentPosition = nextChunkEnd;
        }
        
        return chunks;
    }

    private findSafeChunkBoundary(content: string, start: number, end: number): number {
        // 添加最大查找范围限制
        const MAX_LOOKAHEAD = 1000; // 最大向前查找1000字符
        const limitedEnd = Math.min(end + MAX_LOOKAHEAD, content.length);
        
        const safePoints = [
            this.findNextTagEnd(content, Math.min(end, limitedEnd)),
            this.findNextExpressionEnd(content, Math.min(end, limitedEnd)),
            this.findNextCommentEnd(content, Math.min(end, limitedEnd))
        ];
        
        // 过滤掉无效的分割点
        const validPoints = safePoints
            .filter(point => point > start && point <= content.length)
            .filter(point => this.isValidBoundary(content, point));
        
        return validPoints.length > 0 ? Math.min(...validPoints) : end;
    }

    private isValidBoundary(content: string, position: number): boolean {
        // 确保不会切割在标签、表达式或注释的中间
        const surroundingText = content.slice(Math.max(0, position - 10), Math.min(content.length, position + 10));
        
        // 检查是否在标签中间
        if (surroundingText.includes('<') && !surroundingText.includes('>')) return false;
        
        // 检查是否在表达式中间
        if (surroundingText.includes('{{') && !surroundingText.includes('}}')) return false;
        
        // 检查是否在注释中间
        if (surroundingText.includes('<!--') && !surroundingText.includes('-->')) return false;
        
        return true;
    }

    private findNextTagEnd(content: string, position: number): number {
        let pos = position;
        while (pos < content.length) {
            if (content[pos] === '<') {
                // 查找标签结束位置
                const tagEnd = content.indexOf('>', pos);
                if (tagEnd === -1) return content.length;
                
                // 检查是否是自闭合标签
                if (content[tagEnd - 1] === '/') {
                    return tagEnd + 1;
                }
                
                // 获取标签名
                const tagMatch = content.slice(pos, tagEnd).match(/<\/?([a-zA-Z][a-zA-Z0-9:-]*)/);
                if (tagMatch) {
                    const tagName = tagMatch[1];
                    if (tagMatch[0].startsWith('</')) {
                        // 结束标签
                        return tagEnd + 1;
            } else {
                        // 开始标签，查找对应的结束标签
                        const endTag = `</${tagName}>`;
                        const endTagPos = content.indexOf(endTag, tagEnd);
                        if (endTagPos === -1) return content.length;
                        return endTagPos + endTag.length;
                    }
                }
            }
            pos++;
        }
        return content.length;
    }

    private findNextExpressionEnd(content: string, position: number): number {
        let pos = position;
        let inExpression = false;
        let bracketCount = 0;
        
        while (pos < content.length) {
            const char = content[pos];
            if (!inExpression && content.slice(pos, pos + 2) === '{{') {
                inExpression = true;
                pos += 2;
                continue;
            }
            
            if (inExpression) {
                if (char === '{') bracketCount++;
                if (char === '}') {
                    if (bracketCount > 0) {
                        bracketCount--;
                    } else if (content[pos + 1] === '}') {
                        return pos + 2;
                    }
                }
            }
            pos++;
        }
        return content.length;
    }

    private findNextCommentEnd(content: string, position: number): number {
        let pos = position;
        while (pos < content.length) {
            if (content.slice(pos, pos + 4) === '<!--') {
                const commentEnd = content.indexOf('-->', pos);
                if (commentEnd === -1) return content.length;
                return commentEnd + 3;
            }
            pos++;
        }
        return content.length;
    }

    private extractFilterReferences(document: vscode.TextDocument, expression: string, fileInfo: FileInfo, startIndex: number): void {
        HtmlParser.COMPILED_REGEXES.filter.lastIndex = 0;
        let filterMatch;
        while ((filterMatch = HtmlParser.COMPILED_REGEXES.filter.exec(expression)) !== null) {
            const filterName = filterMatch[1];
            const position = document.offsetAt(document.positionAt(startIndex + filterMatch.index + filterMatch[0].indexOf(filterName)));
            
            if (!fileInfo.filters.has(filterName)) {
                fileInfo.filters.set(filterName, []);
            }
            fileInfo.filters.get(filterName)!.push({
                name: filterName,
                position,
                type: 'filter',
                isDefinition: false
            });
        }
    }

    private extractScopeReferences(document: vscode.TextDocument, expression: string, fileInfo: FileInfo, startIndex: number): void {
        HtmlParser.COMPILED_REGEXES.scopeVar.lastIndex = 0;
        let scopeMatch;
        while ((scopeMatch = HtmlParser.COMPILED_REGEXES.scopeVar.exec(expression)) !== null) {
            const variableName = scopeMatch[1];
            const position = document.offsetAt(document.positionAt(startIndex + scopeMatch.index + scopeMatch[0].indexOf(variableName)));
            this.addScopeVariableToFileInfo(fileInfo, variableName, position, false);
        }
    }

    private addFunctionToFileInfo(fileInfo: FileInfo, name: string, position: number, isDefinition: boolean) {
        if (!fileInfo.functions.has(name)) {
            fileInfo.functions.set(name, []);
        }
        fileInfo.functions.get(name)!.push({
            name,
            position,
            type: 'function',
            isDefinition
        });
    }

    private addScopeVariableToFileInfo(fileInfo: FileInfo, name: string, position: number, isDefinition: boolean) {
        fileInfo.scopeVariables.set(name, {
            name,
            position,
            type: 'scopeVariable',
            isDefinition
        });
    }

    private hashContent(content: string): string {
        let hash = 0;
        for (let i = 0; i < content.length; i++) {
            const char = content.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash;
        }
        return hash.toString(36);
    }

    private updateCache(
        filePath: string,
        fileInfo: FileInfo,
        associatedJsFiles: string[],
        contentHash: string
    ): void {
        const now = Date.now();
        
        // 更新缓存
        this.parseResultCache.set(filePath, {
            fileInfo,
            associatedJsFiles,
            timestamp: now,
            hash: contentHash
        });

        // 清理过期缓存
        if (this.parseResultCache.size > this.MAX_CACHE_SIZE) {
            const entries = Array.from(this.parseResultCache.entries());
            entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
            
            // 删除最旧的条目直到达到目标大小
            const toDelete = entries.slice(0, entries.length - this.MAX_CACHE_SIZE);
            toDelete.forEach(([key]) => this.parseResultCache.delete(key));
        }
    }
}
