import * as vscode from 'vscode';
import { AngularDefinition, AngularParser, FileInfo } from './angularParser';
import { LRUCache } from 'lru-cache';
import * as path from 'path';

/**
 * DefinitionProvider 类实现了 vscode.DefinitionProvider 接口
 * 用于提供 Angular 定义的查找功能
 */
export class DefinitionProvider implements vscode.DefinitionProvider {
    private cache: LRUCache<string, vscode.Location>;
    private workspaceRoot: string | undefined;
    private performanceLog: { [key: string]: number[] } = {};
    private enablePerformanceLogging: boolean;

    /**
     * 创建 DefinitionProvider 的实例
     * @param {AngularParser} angularParser - Angular 解析器实例
     */
    constructor(private angularParser: AngularParser) {
        const config = vscode.workspace.getConfiguration('angularHelper');
        const cacheSize = config.get<number>('definitionCacheSize', 100);
        const cacheTTL = vscode.workspace.getConfiguration('angularDefinitionProvider').get<number>('cacheTTL', 3600000);
        this.enablePerformanceLogging = config.get<boolean>('enablePerformanceLogging', false);
        
        this.cache = new LRUCache<string, vscode.Location>({
            max: cacheSize,
            ttl: cacheTTL
        });
        
        this.workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    }

    /**
     * 提供定义位置
     * @param {vscode.TextDocument} document - 当前文档
     * @param {vscode.Position} position - 光标位置
     * @returns {Promise<vscode.Location | undefined>} 定义位置
     */
    async provideDefinition(
        document: vscode.TextDocument,
        position: vscode.Position,        
    ): Promise<vscode.Location | undefined> {
        const startTime = performance.now();
        
        const wordRange = document.getWordRangeAtPosition(position);
        if (!wordRange) {
            return undefined;
        }
        const word = document.getText(wordRange);

        // 构建缓存键，使用文档URI和单词组合以确保唯一性
        const cacheKey = `${document.uri.toString()}:${word}`;
        const cachedResult = this.cache.get(cacheKey);
        if (cachedResult) {
            this.logPerformance('cacheHit', startTime);
            return cachedResult;
        }

        let result: vscode.Location | undefined;

        // 根据不同的文件类型和上下文选择适当的查找方法
        if (this.isAngularExpression(document, position)) {
            // 对于Angular表达式，在HTML中查找定义
            result = await this.findAngularExpressionDefinitionInHtml(word, document);
        } else if (document.languageId === 'html') {
            // 对于HTML文件中的普通单词，在TypeScript文件中查找定义
            result = await this.findDefinitionInTypeScript(word, document);
        } else if (['typescript', 'javascript'].includes(document.languageId)) {
            // 对于TypeScript/JavaScript文件中的单词，在HTML文件中查找使用位置
            result = this.findDefinitionInHtml(word);
        }

        // 如果找到结果，更新缓存
        if (result) {
            this.cache.set(cacheKey, result);
        }

        this.logPerformance('definitionLookup', startTime);
        return result;
    }

    /**
     * 检查是否是 Angular 表达式
     * 这个方法使用正则表达式来识别常见的Angular表达式模式
     * @param {vscode.TextDocument} document - 当前文档
     * @param {vscode.Position} position - 光标位置
     * @returns {boolean} 是否是 Angular 表达式
     */
    private isAngularExpression(document: vscode.TextDocument, position: vscode.Position): boolean {
        const lineText = document.lineAt(position.line).text;
        // 检查ng-*属性和{{}}插值表达式
        // 这里的正则表达式匹配如 ng-click="ctrl.doSomething()" 或 {{user.name}} 这样的模式
        return /ng-[a-zA-Z-]+="[^"]*\b\w+(?:\.\w+)+\b[^"]*"/.test(lineText) || 
               /{{[^}]*\b\w+(?:\.\w+)+\b[^}]*}}/.test(lineText);
    }

    /**
     * 在 HTML 中查找 Angular 表达式的定义
     * 这个方法首先在当前HTML文件中查找，如果没找到则在相关的JS文件中查找
     * @param {string} property - 要查找的属性
     * @param {vscode.TextDocument} document - 当前文档
     * @returns {Promise<vscode.Location | undefined>} 定义位置
     */
    private async findAngularExpressionDefinitionInHtml(property: string, document: vscode.TextDocument): Promise<vscode.Location | undefined> {
        const content = document.getText();
        // 构建正则表达式来匹配ng-*属性和{{}}插值表达式
        const regex = new RegExp(`(ng-[a-zA-Z-]+="[^"]*${property}[^"]*")|({{[^}]*${property}[^}]*}})`, 'g');
        const matches = Array.from(content.matchAll(regex));

        // 如果在当前HTML文件中找到匹配，返回第一个匹配的位置
        for (const match of matches) {
            if (match.index !== undefined) {
                return new vscode.Location(
                    document.uri,
                    document.positionAt(match.index)
                );
            }
        }

        // 如果在当前HTML文件中没找到，尝试在相关的JS文件中查找
        const jsFiles = await vscode.workspace.findFiles('**/*.js');
        return this.searchInFiles(jsFiles, regex);
    }

    /**
     * 在文件中搜索定义
     * @param {vscode.Uri[]} files - 要搜索的文件 URI 数组
     * @param {RegExp} regex - 搜索用的正则表达式
     * @returns {Promise<vscode.Location | undefined>} 定义位置
     */
    private async searchInFiles(files: vscode.Uri[], regex: RegExp): Promise<vscode.Location | undefined> {
        for (const file of files) {
            if (!this.isFileInWorkspace(file)) {
                console.warn(`Skipping file outside of workspace: ${file.fsPath}`);
                continue;
            }

            try {
                const otherDocument = await vscode.workspace.openTextDocument(file);
                const otherContent = otherDocument.getText();
                const match = regex.exec(otherContent);
                if (match && match.index !== undefined) {
                    return new vscode.Location(file, otherDocument.positionAt(match.index));
                }
            } catch (error) {
                console.error(`Error opening ${file.fsPath}:`, error);
            }
        }
        return undefined;
    }

    /**
     * 检查文件是否在工作区内
     * @param {vscode.Uri} file - 要检查的文件 URI
     * @returns {boolean} 文件是否在工作区内
     */
    private isFileInWorkspace(file: vscode.Uri): boolean {
        if (!this.workspaceRoot) {
            return false;
        }
        const relativePath = path.relative(this.workspaceRoot, file.fsPath);
        return !relativePath.startsWith('..') && !path.isAbsolute(relativePath);
    }

    /**
     * 在 TypeScript 文件中查找定义
     * @param {string} word - 要查找的单词
     * @param {vscode.TextDocument} document - 当前文档
     * @returns {Promise<vscode.Location | undefined>} 定义位置
     */
    private async findDefinitionInTypeScript(word: string, document: vscode.TextDocument): Promise<vscode.Location | undefined> {
        const allFiles = this.angularParser.getAllParsedFiles();
        for (const fileName of allFiles) {
            if (!this.isFileInWorkspace(vscode.Uri.file(fileName))) {
                console.warn(`Skipping file outside of workspace: ${fileName}`);
                continue;
            }

            const fileInfo = this.angularParser.getFileInfo(fileName);
            if (fileInfo) {
                const definition = this.findDefinitionInFileInfo(fileInfo, word);
                if (definition) {
                    const result = new vscode.Location(
                        vscode.Uri.file(fileName),
                        new vscode.Position(definition.position, 0)
                    );
                    this.cache.set(`${document.uri.toString()}:${word}`, result);
                    return result;
                }
            }
        }

        return this.findDefinitionInCurrentHtml(word, document);
    }

    /**
     * 在文件信息中查找定义
     * @param {FileInfo} fileInfo - 文件信息
     * @param {string} word - 要查找的单词
     * @returns {AngularDefinition | undefined} 找到的定义
     */
    private findDefinitionInFileInfo(fileInfo: FileInfo, word: string): AngularDefinition | undefined {
        const definitionTypes: (keyof FileInfo)[] = ['controllers', 'services', 'directives', 'functions', 'scopeVariables', 'components'];
        for (const type of definitionTypes) {
            const definitions = fileInfo[type];
            if (definitions instanceof Map) {
                const definition = definitions.get(word);
                if (definition) {
                    return definition;
                }
            }
        }
        return undefined;
    }

    /**
     * 在当前 HTML 文件中查找定义
     * @param {string} word - 要查找的单词
     * @param {vscode.TextDocument} document - 当前文档
     * @returns {vscode.Location | undefined} 定义位置
     */
    private findDefinitionInCurrentHtml(word: string, document: vscode.TextDocument): vscode.Location | undefined {
        const content = document.getText();
        // 使用正则表达式查找 ng- 属性
        const regex = new RegExp(`ng-[a-zA-Z-]+="${word}"`, 'g');
        const matches = Array.from(content.matchAll(regex));

        for (const match of matches) {
            if (match.index !== undefined) {
                // 返回找到的位置
                return new vscode.Location(
                    document.uri,
                    document.positionAt(match.index)
                );
            }
        }

        return undefined;
    }

    /**
     * 在 HTML 文件中查找定义
     * @param {string} word - 要查找的单词
     * @returns {vscode.Location | undefined} 定义位置
     */
    private findDefinitionInHtml(word: string): vscode.Location | undefined {
        const allFiles = this.angularParser.getAllParsedFiles();
        for (const fileName of allFiles) {
            const fileInfo = this.angularParser.getFileInfo(fileName);
            if (fileInfo) {
                const attribute = fileInfo.ngAttributes.get(word);
                if (attribute) {
                    return new vscode.Location(
                        vscode.Uri.file(fileName),
                        this.positionFromOffset(attribute.position, fileName)
                    );
                }

                const controller = fileInfo.ngControllers.get(word);
                if (controller) {
                    return new vscode.Location(
                        vscode.Uri.file(fileName),
                        this.positionFromOffset(controller.position, fileName)
                    );
                }
            }
        }
        return undefined;
    }

    /**
     * 将偏移量转换为 Position 对象
     * @param {number} offset - 偏移量
     * @param {string} fileName - 文件名
     * @returns {vscode.Position} 转换后的 Position 对象
     */
    private positionFromOffset(offset: number, fileName: string): vscode.Position {
        const document = vscode.workspace.textDocuments.find(doc => doc.fileName === fileName);
        if (document) {
            return document.positionAt(offset);
        }
        return new vscode.Position(0, 0);
    }

    /**
     * 记录性能数据
     * @param {string} operation - 操作名称
     * @param {number} startTime - 开始时间
     */
    private logPerformance(operation: string, startTime: number) {
        if (!this.enablePerformanceLogging) {
            return;
        }

        const duration = performance.now() - startTime;
        if (!this.performanceLog[operation]) {
            this.performanceLog[operation] = [];
        }
        this.performanceLog[operation].push(duration);

        // 每100次操作后，计算并输出平均时间
        if (this.performanceLog[operation].length % 100 === 0) {
            const average = this.performanceLog[operation].reduce((a, b) => a + b, 0) / this.performanceLog[operation].length;
            console.log(`Average time for ${operation}: ${average.toFixed(2)}ms`);
        }
    }

    /**
     * 输出性能报告
     */
    public outputPerformanceReport() {
        if (!this.enablePerformanceLogging) {
            console.log('Performance logging is disabled.');
            return;
        }

        console.log('Performance Report:');
        for (const [operation, times] of Object.entries(this.performanceLog)) {
            const average = times.reduce((a, b) => a + b, 0) / times.length;
            console.log(`${operation}: Average ${average.toFixed(2)}ms, Count: ${times.length}`);
        }
    }
}