import * as vscode from 'vscode';
import { AngularParser } from './angularParser';
import { FileInfo, SUPPORTED_LANGUAGES, AngularDefinition } from './types/types';
import { FileUtils } from './utils/FileUtils';

export class ReferenceProvider implements vscode.ReferenceProvider {
    // 缓存配置
    private readonly CACHE_TTL = 3000; // 3秒缓存过期时间
    private readonly MAX_CACHE_SIZE = 1000; // 最大缓存条目数
    private readonly BATCH_SIZE = 10; // 并发处理批次大小

    // 缓存
    private referenceCache = new Map<string, {
        references: vscode.Location[];
        timestamp: number;
        hash: string;
    }>();

    constructor(private angularParser: AngularParser) {}

    public async provideReferences(
        document: vscode.TextDocument,
        position: vscode.Position,
    ): Promise<vscode.Location[]> {
        try {
            const wordRange = document.getWordRangeAtPosition(position, /[$a-zA-Z_][$\w]*/);
            if (!wordRange) {
                return [];
            }

            const word = document.getText(wordRange);
            const line = document.lineAt(position.line).text;
            const cacheKey = this.generateCacheKey(document.uri.fsPath, word, line, position);
            
            // 检查缓存
            const cached = this.referenceCache.get(cacheKey);
            if (cached && (Date.now() - cached.timestamp) < this.CACHE_TTL) {
                FileUtils.logDebugForFindDefinitionAndReference(`使用缓存的引用结果: ${word}`);
                return cached.references;
            }

            FileUtils.logDebugForFindDefinitionAndReference(
                `正在查找引用: ${word}, 文件: ${document.fileName}, ` + 
                `位置: ${position.line+1}:${position.character+1}`
            );

            // 并行处理当前文件和关联文件
            const [currentFileRefs, associatedFileRefs] = await Promise.all([
                this.findReferencesInCurrentFile(document, word),
                this.findReferencesInAssociatedFiles(document, word)
            ]);

            // 合并结果并去重
            const uniqueReferences = this.mergeAndDedupReferences([
                ...currentFileRefs,
                ...associatedFileRefs
            ]);

            // 更新缓存
            this.updateCache(cacheKey, uniqueReferences, line);

            return uniqueReferences;
        } catch (error) {
            FileUtils.logError(`查找引用时出错: ${error}`, error);
            return [];
        }
    }

    private async findReferencesInCurrentFile(
        document: vscode.TextDocument,
        word: string
    ): Promise<vscode.Location[]> {
        const references = new Map<string, vscode.Location>();

        try {
            const currentFileInfo = this.angularParser.getFileInfo(document.uri.fsPath);
            if (currentFileInfo) {
                this.findReferencesInFileInfo(currentFileInfo, document.uri, word, references);
            } else {
                await this.angularParser.parseFile(document.uri);
                const updatedFileInfo = this.angularParser.getFileInfo(document.uri.fsPath);
                if (updatedFileInfo) {
                    this.findReferencesInFileInfo(updatedFileInfo, document.uri, word, references);
                }
            }
        } catch (error) {
            FileUtils.logError(`在当前文件中查找引用时出错: ${document.fileName}`, error);
        }

        return Array.from(references.values());
    }

    private async findReferencesInAssociatedFiles(
        document: vscode.TextDocument,
        word: string
    ): Promise<vscode.Location[]> {
        const associatedFiles = this.getAssociatedFiles(document);
        const references = new Map<string, vscode.Location>();

        // 分批处理关联文件
        for (let i = 0; i < associatedFiles.length; i += this.BATCH_SIZE) {
            const batch = associatedFiles.slice(i, i + this.BATCH_SIZE);
            const batchPromises = batch.map(async (file) => {
                try {
                    const tempReferences = new Map<string, vscode.Location>();
                    const fileInfo = this.angularParser.getFileInfo(file);
                    const uri = vscode.Uri.file(file);

                    if (fileInfo) {
                        this.findReferencesInFileInfo(fileInfo, uri, word, tempReferences);
                    } else {
                        await this.angularParser.parseFile(uri);
                        const updatedFileInfo = this.angularParser.getFileInfo(file);
                        if (updatedFileInfo) {
                            this.findReferencesInFileInfo(updatedFileInfo, uri, word, tempReferences);
                        }
                    }

                    return tempReferences;
                } catch (error) {
                    FileUtils.logError(`处理关联文件时出错: ${file}`, error);
                    return new Map<string, vscode.Location>();
                }
            });

            const batchResults = await Promise.all(batchPromises);
            batchResults.forEach(result => {
                result.forEach((value, key) => references.set(key, value));
            });
        }

        return Array.from(references.values());
    }

    private async findReferencesInFileInfo(
        fileInfo: FileInfo, 
        uri: vscode.Uri,
        word: string, 
        references: Map<string, vscode.Location>
    ): Promise<void> {
        try {
            // 先检查是否是有效的标识符
            if (!/^[$a-zA-Z_][$\w]*$/.test(word)) {
                FileUtils.logDebugForFindDefinitionAndReference(
                    `跳过无效的标识符: ${word}`
                );
                return;
            }

            await this.withErrorRecovery(async () => {
                await this.checkDirectReferences(fileInfo, uri, word, references);
            }, undefined);

            await this.withErrorRecovery(async () => {
                await this.checkAliasReferences(fileInfo, uri, word, references);
            }, undefined);

            await this.withErrorRecovery(async () => {
                await this.checkInheritanceReferences(fileInfo, uri, word, references);
            }, undefined);
            
        } catch (error) {
            FileUtils.logError(`在文件 ${uri.fsPath} 中查找 ${word} 的引用时出错:`, error);
        }
    }

    private async withErrorRecovery<T>(operation: () => Promise<T>, fallback: T): Promise<T> {
        try {
            return await operation();
        } catch (error) {
            FileUtils.logError('操作失败，使用降级策略', error);
            return fallback;
        }
    }

    private async checkDirectReferences(
        fileInfo: FileInfo,
        uri: vscode.Uri,
        word: string,
        references: Map<string, vscode.Location>
    ): Promise<void> {
        // 检查所有可能的引用来源
        this.checkMapForReferences(fileInfo.functions, word, fileInfo, uri, references);
        this.checkMapForReferences(fileInfo.filters, word, fileInfo, uri, references);
        this.checkSingleDefinitionMap(fileInfo.controllers, word, fileInfo, uri, references);
        this.checkSingleDefinitionMap(fileInfo.services, word, fileInfo, uri, references);
        this.checkSingleDefinitionMap(fileInfo.directives, word, fileInfo, uri, references);
        this.checkSingleDefinitionMap(fileInfo.components, word, fileInfo, uri, references);
        this.checkSingleDefinitionMap(fileInfo.scopeVariables, word, fileInfo, uri, references);
        this.checkSingleDefinitionMap(fileInfo.ngAttributes, word, fileInfo, uri, references);
        this.checkSingleDefinitionMap(fileInfo.ngControllers, word, fileInfo, uri, references);
    }

    private async checkAliasReferences(
        fileInfo: FileInfo,
        uri: vscode.Uri,
        word: string,
        references: Map<string, vscode.Location>
    ): Promise<void> {
        // 检查变量别名
        const aliases = await this.findAliases(fileInfo, word);
        for (const alias of aliases) {
            await this.findReferencesForAlias(fileInfo, uri, alias, references);
        }
    }

    private async findAliases(fileInfo: FileInfo, word: string): Promise<string[]> {
        const aliases = new Set<string>();
        
        // 检查变量赋值
        fileInfo.functions.forEach((refs, name) => {
            for (const ref of refs) {
                if (ref.isDefinition && ref.aliasFor === word) {
                    aliases.add(name);
                }
            }
        });
        
        // 检查 require/import 语句
        if (fileInfo.imports) {
            fileInfo.imports.forEach((importInfo, name) => {
                if (importInfo.originalName === word) {
                    aliases.add(name);
                }
            });
        }
        
        return Array.from(aliases);
    }

    private async findReferencesForAlias(
        fileInfo: FileInfo,
        uri: vscode.Uri,
        alias: string,
        references: Map<string, vscode.Location>
    ): Promise<void> {
        // 查找别名的所有引用
        const refs = fileInfo.functions.get(alias);
        if (refs) {
            for (const ref of refs) {
                if (!ref.isDefinition) {
                    this.addReference(ref, fileInfo, uri, alias, references);
                }
            }
        }
    }

    private async checkInheritanceReferences(
        fileInfo: FileInfo,
        uri: vscode.Uri,
        word: string,
        references: Map<string, vscode.Location>
    ): Promise<void> {
        // 检查继承关系
        if (fileInfo.inheritance) {
            const inheritors = fileInfo.inheritance.get(word);
            if (inheritors) {
                for (const inheritor of inheritors) {
                    // 查找继承类中的引用
                    const refs = fileInfo.functions.get(inheritor);
                    if (refs) {
                        for (const ref of refs) {
                            if (!ref.isDefinition) {
                                this.addReference(ref, fileInfo, uri, inheritor, references);
                            }
                        }
                    }
                }
            }
        }
    }

    private checkMapForReferences(
        map: Map<string, AngularDefinition[]>,
        word: string,
        fileInfo: FileInfo,
        uri: vscode.Uri,
        references: Map<string, vscode.Location>
    ): void {
        const refs = map.get(word);
        if (refs) {
            for (const ref of refs) {
                if (!ref.isDefinition) {
                    this.addReference(ref, fileInfo, uri, word, references);
                }
            }
        }
    }

    private checkSingleDefinitionMap(
        map: Map<string, AngularDefinition>,
        word: string,
        fileInfo: FileInfo,
        uri: vscode.Uri,
        references: Map<string, vscode.Location>
    ): void {
        const ref = map.get(word);
        if (ref && !ref.isDefinition) {
            this.addReference(ref, fileInfo, uri, word, references);
        }
    }

    private addReference(
        ref: AngularDefinition,
        fileInfo: FileInfo,
        uri: vscode.Uri,
        word: string,
        references: Map<string, vscode.Location>
    ): void {
        const refPosition = this.angularParser.getPositionLocation(fileInfo.filePath, ref.position);
        const range = new vscode.Range(refPosition, refPosition.translate(0, word.length));
        const key = `${uri.fsPath}:${refPosition.line}:${refPosition.character}`;
        
        if (!references.has(key)) {
            references.set(key, new vscode.Location(uri, range));
        }
    }

    private getAssociatedFiles(document: vscode.TextDocument): string[] {
        return document.languageId === SUPPORTED_LANGUAGES.JAVASCRIPT 
            ? this.angularParser.getAssociatedHtmlFiles(document.uri.fsPath)
            : document.languageId === SUPPORTED_LANGUAGES.HTML 
                ? this.angularParser.getAssociatedJsFiles(document.uri.fsPath)
                : [];
    }

    private generateCacheKey(filePath: string, word: string, line: string, position: vscode.Position): string {
        const hash = this.hashString(line);
        return `${filePath}:${word}:${position.line}:${position.character}:${hash}`;
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

    private updateCache(key: string, references: vscode.Location[], content: string): void {
        const now = Date.now();
        
        // 更新缓存
        this.referenceCache.set(key, {
            references,
            timestamp: now,
            hash: this.hashString(content)
        });

        // 清理过期缓存
        if (this.referenceCache.size > this.MAX_CACHE_SIZE) {
            const entries = Array.from(this.referenceCache.entries());
            entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
            
            // 删除最旧的条目直到达到目标大小
            const toDelete = entries.slice(0, entries.length - this.MAX_CACHE_SIZE);
            toDelete.forEach(([key]) => this.referenceCache.delete(key));
        }
    }

    private mergeAndDedupReferences(references: vscode.Location[]): vscode.Location[] {
        const uniqueRefs = new Map<string, vscode.Location>();
        
        references.forEach(ref => {
            const key = `${ref.uri.fsPath}:${ref.range.start.line}:${ref.range.start.character}`;
            if (!uniqueRefs.has(key)) {
                uniqueRefs.set(key, ref);
            }
        });

        return Array.from(uniqueRefs.values());
    }
}
