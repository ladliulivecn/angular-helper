/* eslint-disable curly */
import { LRUCache } from 'lru-cache';
import * as path from 'path';
import * as ts from 'typescript';
import * as vscode from 'vscode';
import { log, logError } from './extension';

/**
 * Angular 类型常量
 * @constant
 */
const ANGULAR_TYPES = {
  CONTROLLER: 'controller',
  SERVICE: 'service',
  FACTORY: 'factory',
  DIRECTIVE: 'directive',
  COMPONENT: 'component'
};

/**
 * 支持的语言常量
 * @constant
 */
const SUPPORTED_LANGUAGES = {
  JAVASCRIPT: 'javascript',
  HTML: 'html'
};

/**
 * Angular 定义接口
 * @interface AngularDefinition
 */
export interface AngularDefinition {
    /** 定义的名称 */
    name: string;
    /** 定义在文件中的位置 */
    position: number;
    /** 定义的类型 */
    type: string;
    /** 定义的值（可选） */
    value?: string;
}

/**
 * 文件信息接口
 * @interface FileInfo
 */
export interface FileInfo {
    components: Map<string, AngularDefinition>;
    controllers: Map<string, AngularDefinition>;
    services: Map<string, AngularDefinition>;
    directives: Map<string, AngularDefinition>;
    functions: Map<string, AngularDefinition>;
    scopeVariables: Map<string, AngularDefinition>;
    ngAttributes: Map<string, AngularDefinition>;
    ngDirectives: string[];
    ngControllers: Map<string, AngularDefinition>;
    styles: Map<string, AngularDefinition>;
    [key: string]: Map<string, AngularDefinition> | string[] | undefined;
}

/**
 * Angular 解析器类
 * 这个类负责解析 Angular 项目中的文件，建立文件之间的关联，
 * 并提供查找定义的功能。
 */
export class AngularParser {
    private fileMap: LRUCache<string, FileInfo>;
    private parseQueue: vscode.Uri[] = [];
    private isParsingQueue = false;
    private maxConcurrentParsing: number;
    private parsingFiles: Set<string> = new Set();
    private rootDirAliases: { [key: string]: string };
    private ignorePatterns: string[];
    private htmlToJsMap: Map<string, string[]> = new Map();
    private jsToHtmlMap: Map<string, string[]> = new Map();

    /**
     * 创建 AngularParser 的实例
     * 初始化解析器的各种设置，包括缓存大小、忽略模式等。
     */
    constructor() {
        const config = vscode.workspace.getConfiguration('angularHelper');
        this.maxConcurrentParsing = config.get<number>('maxConcurrentParsing', 5);
        const maxCachedFiles = config.get<number>('maxCachedFiles', 100);
        const cacheTTL = config.get<number>('cacheTTL', 60 * 60 * 1000); // 默认1小时,单位毫秒

        this.fileMap = new LRUCache<string, FileInfo>({
            max: maxCachedFiles,
            ttl: cacheTTL
        });

        this.rootDirAliases = config.get<{ [key: string]: string }>('rootDirAliases', {
            '__ROOT__': '',
            '__PUBLIC__': 'Public'
        });
        this.ignorePatterns = config.get<string[]>('ignoreScriptPatterns', [
            '*.min.js',
            'http://*',
            'https://*'
        ]);

        // 添加默认忽略的文件夹
        this.ignorePatterns.push(...AngularParser.getDefaultExcludePatterns());
    }
    
    /**
     * 解析单个文件
     * 这个方法负责解析单个文件，并更新相关的文件关联。
     * @param {vscode.Uri} file - 要解析的文件 URI
     * @returns {Promise<void>}
     */
    public async parseFile(file: vscode.Uri): Promise<void> {
        const filePath = file.fsPath;
        if (this.parsingFiles.has(filePath)) {
            log(`文件 ${filePath} 正在解析中，跳过`);
            return;
        }

        this.parsingFiles.add(filePath);
        try {
            log(`开始解析文件: ${filePath}`);
            const document = await vscode.workspace.openTextDocument(file);
            await this.parseFileByType(document);

            // 如果是 JS 文件，解析关联的 HTML 文件
            if (path.extname(filePath).toLowerCase() === '.js') {
                const associatedHtmlFiles = this.jsToHtmlMap.get(filePath) || [];
                for (const htmlFile of associatedHtmlFiles) {
                    await this.parseFile(vscode.Uri.file(htmlFile));
                }
            }

            log(`文件解析完成: ${filePath}`);
        } catch (error) {
            logError(`解析文件 ${filePath} 时出错:`, error);            
        } finally {
            this.parsingFiles.delete(filePath);
        }
    }

    /**
     * 处理解析队列
     * 这个方法负责处理待解析的文件队列。它会批量处理文件，
     * 并支持通过取消令牌取消解析过程。
     * @param {vscode.CancellationToken} token - 取消令牌
     * @returns {Promise<void>}
     * @private
     */
    private async processQueue(token: vscode.CancellationToken): Promise<void> {
        if (this.isParsingQueue) return;
        this.isParsingQueue = true;

        try {
            while (this.parseQueue.length > 0) {
                if (token.isCancellationRequested) {
                    throw new vscode.CancellationError();
                }
                const batch = this.parseQueue.splice(0, this.maxConcurrentParsing);
                await Promise.all(batch.map(file => this.parseFile(file)));
            }
        } catch (error) {
            if (error instanceof vscode.CancellationError) {
                log('解析队列处理被取消');
            } else {
                logError('处理解析队列时出错:', error);
            }
        } finally {
            this.isParsingQueue = false;
        }
    }

    /**
     * 初始化解析器
     * 这个方法是解析器的主要入口点。它会过滤文件，建立文件关联，
     * 并开始解析过程。
     * @param {vscode.Uri[]} files - 要解析的文件 URI 数组
     * @param {vscode.CancellationToken} token - 取消令牌
     * @returns {Promise<void>}
     */
    public async initializeParser(files: vscode.Uri[], token: vscode.CancellationToken): Promise<void> {
        const filteredFiles = files.filter(file => !this.shouldIgnoreFile(file.fsPath));
        await this.buildFileAssociations(filteredFiles, token);
        this.parseQueue = filteredFiles;
        await this.processQueue(token);
    }

    /**
     * 建立文件关联
     * 这个方法负责分析 HTML 文件，找出其中引用的 JS 文件，
     * 并建立 HTML 和 JS 文件之间的关联。
     * @param {vscode.Uri[]} files - 要分析的文件 URI 数组
     * @param {vscode.CancellationToken} token - 取消令牌
     * @returns {Promise<void>}
     * @private
     */
    private async buildFileAssociations(files: vscode.Uri[], token: vscode.CancellationToken): Promise<void> {
        for (const file of files) {
            if (token.isCancellationRequested) {
                throw new vscode.CancellationError();
            }
            if (path.extname(file.fsPath).toLowerCase() === '.html') {
                await this.analyzeHtmlFile(file);
            }
        }
    }

    /**
     * 分析 HTML 文件
     * 这个方法负责分析单个 HTML 文件，找出其中引用的 JS 文件，
     * 并更新文件关联映射。
     * @param {vscode.Uri} file - 要分析的 HTML 文件 URI
     * @returns {Promise<void>}
     * @private
     */
    private async analyzeHtmlFile(file: vscode.Uri): Promise<void> {
        try {
            const document = await vscode.workspace.openTextDocument(file);
            const content = document.getText();
            const scriptRegex = /<script\s+(?:[^>]*?\s+)?src=["']([^"']+)["'][^>]*>/g;
            const jsFiles: string[] = [];

            let match;
            while ((match = scriptRegex.exec(content)) !== null) {
                const scriptSrc = match[1];
                if (!this.shouldIgnoreScript(scriptSrc)) {
                    const resolvedPath = this.resolveScriptPath(scriptSrc, file);
                    if (resolvedPath) {
                        jsFiles.push(resolvedPath.fsPath);
                        if (!this.jsToHtmlMap.has(resolvedPath.fsPath)) {
                            this.jsToHtmlMap.set(resolvedPath.fsPath, []);
                        }
                        this.jsToHtmlMap.get(resolvedPath.fsPath)!.push(file.fsPath);
                    }
                }
            }

            if (jsFiles.length > 0) {
                this.htmlToJsMap.set(file.fsPath, jsFiles);
            } else {
                // 标记为内部实现 JS 逻辑
                this.htmlToJsMap.set(file.fsPath, []);
            }
        } catch (error) {
            logError(`分析 HTML 文件 ${file.fsPath} 时出错:`, error);
        }
    }

    /**
     * 根据文件类型解析文件
     * @private
     * @param {vscode.TextDocument} document - 要解析的文档
     * @returns {Promise<void>}
     */
    private async parseFileByType(document: vscode.TextDocument): Promise<void> {
        const fileName = document.fileName;
        let fileInfo: FileInfo;

        try {
            if (document.languageId === SUPPORTED_LANGUAGES.JAVASCRIPT) {
                fileInfo = this.parseJavaScriptFile(document);
            } else if (document.languageId === SUPPORTED_LANGUAGES.HTML) {
                fileInfo = await this.parseHtmlFile(document);
            } else {
                log(`不支持的文件类型: ${document.languageId}, 文件: ${fileName}`);
                return;
            }

            this.fileMap.set(fileName, fileInfo);
            log(`成功解析文件: ${fileName}`);
        } catch (error) {
            logError(`解析文件 ${fileName} 时发生错误:`, error);
            throw error;
        }
    }

    /**
     * 解析 JavaScript 文件
     * @private
     * @param {vscode.TextDocument} document - 要解析的文档
     * @returns {FileInfo} 解析后的文件信息
     */
    private parseJavaScriptFile(document: vscode.TextDocument): FileInfo {
        try {
            const sourceFile = ts.createSourceFile(
                document.fileName,
                document.getText(),
                ts.ScriptTarget.Latest,
                true
            );

            const fileInfo: FileInfo = this.createEmptyFileInfo();

            ts.forEachChild(sourceFile, node => {
                if (ts.isVariableStatement(node)) {
                    this.parseVariableStatement(node, fileInfo);
                } else if (ts.isFunctionDeclaration(node)) {
                    this.parseFunctionDeclaration(node, fileInfo);
                }
            });

            return fileInfo;
        } catch (error) {
            logError(`解析 JavaScript 文件 ${document.fileName} 时出错:`, error);
            return this.createEmptyFileInfo();
        }
    }

    /**
     * 解析变量声明语句
     * @private
     * @param {ts.VariableStatement} node - 变量声明语句节点
     * @param {FileInfo} fileInfo - 文件信息对象
     */
    private parseVariableStatement(node: ts.VariableStatement, fileInfo: FileInfo): void {
        node.declarationList.declarations.forEach(declaration => {
            if (!ts.isIdentifier(declaration.name)) return;
            
            const name = declaration.name.text;
            const initializer = declaration.initializer;
            if (!initializer || !ts.isObjectLiteralExpression(initializer)) return;

            initializer.properties.forEach(prop => {
                if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) return;

                const propName = prop.name.text;
                const definition: AngularDefinition = {
                    name,
                    position: declaration.getStart(),
                    type: propName
                };

                switch (propName) {
                    case ANGULAR_TYPES.CONTROLLER:
                        fileInfo.controllers.set(name, definition);
                        break;
                    case ANGULAR_TYPES.SERVICE:
                    case ANGULAR_TYPES.FACTORY:
                        fileInfo.services.set(name, definition);
                        break;
                    case ANGULAR_TYPES.DIRECTIVE:
                        fileInfo.directives.set(name, definition);
                        break;
                    case ANGULAR_TYPES.COMPONENT:
                        fileInfo.components.set(name, definition);
                        break;
                }
            });
        });
    }

    /**
     * 解析函数声明
     * @private
     * @param {ts.FunctionDeclaration} node - 函数声明节点
     * @param {FileInfo} fileInfo - 文件信息对象
     */
    private parseFunctionDeclaration(node: ts.FunctionDeclaration, fileInfo: FileInfo): void {
        if (node.name) {
            fileInfo.functions.set(node.name.text, {
                name: node.name.text,
                position: node.getStart(),
                type: 'function'
            });
        }

        ts.forEachChild(node, child => {
            if (ts.isExpressionStatement(child) && ts.isBinaryExpression(child.expression)) {
                const left = child.expression.left;
                if (ts.isPropertyAccessExpression(left) && left.expression.getText() === '$scope') {
                    fileInfo.scopeVariables.set(left.name.text, {
                        name: left.name.text,
                        position: child.getStart(),
                        type: 'scopeVariable'
                    });
                }
            }
        });
    }

    /**
     * 解析 HTML 文件
     * @private
     * @param {vscode.TextDocument} document - 要解析的 HTML 文档
     * @returns {FileInfo} 解析后的文件信息
     */
    private async parseHtmlFile(document: vscode.TextDocument): Promise<FileInfo> {
        try {
            const content = document.getText();
            const fileInfo = this.createEmptyFileInfo();
            
            // 优先解析导入的 JavaScript 文件
            const importedScripts = this.findImportedScripts(content, document.uri);
            for (const scriptUri of importedScripts) {
                try {
                    const scriptDocument = await vscode.workspace.openTextDocument(scriptUri);
                    const scriptFileInfo = this.parseJavaScriptFile(scriptDocument);
                    this.mergeFileInfo(fileInfo, scriptFileInfo);
                } catch (error) {
                    logError(`解析导入的脚本文件 ${scriptUri.fsPath} 时出错:`, error);
                }
            }

            // 解析 ng-* 属性
            const ngAttributes = content.match(/\bng-[a-zA-Z-]+="([^"]+)"/g) || [];
            ngAttributes.forEach(attr => {
                const match = attr.match(/ng-([a-zA-Z-]+)="([^"]+)"/);
                if (match) {
                    fileInfo.ngAttributes.set(match[2], {
                        name: match[1],
                        position: content.indexOf(attr),
                        type: 'ngAttribute',
                        value: match[2]
                    });
                }
            });

            // 解析 ng 指令
            const ngDirectives = content.match(/\*ng[a-zA-Z]+="([^"]+)"/g) || [];
            fileInfo.ngDirectives = ngDirectives;

            // 解析 ng-controller
            const ngControllers = content.match(/ng-controller="([^"]+)"/g) || [];
            ngControllers.forEach(ctrl => {
                const match = ctrl.match(/ng-controller="([^"]+)"/);
                if (match) {
                    fileInfo.ngControllers.set(match[1], {
                        name: match[1],
                        position: content.indexOf(ctrl),
                        type: 'ngController',
                        value: match[1]
                    });
                }
            });

            // 解析样式
            this.parseStyles(content, fileInfo);

            return fileInfo;
        } catch (error) {
            logError(`解析 HTML 文件 ${document.fileName} 时出错:`, error);
            return this.createEmptyFileInfo();
        }
    }

    private findImportedScripts(content: string, documentUri: vscode.Uri): vscode.Uri[] {
        const scriptRegex = /<script\s+(?:[^>]*?\s+)?src=["']([^"']+)["'][^>]*>/g;
        const scripts: vscode.Uri[] = [];
        let match;

        while ((match = scriptRegex.exec(content)) !== null) {
            const scriptSrc = match[1];
            
            // 忽略网络 JS 和压缩 JS
            if (this.shouldIgnoreScript(scriptSrc)) {
                continue;
            }

            const resolvedPath = this.resolveScriptPath(scriptSrc, documentUri);
            if (resolvedPath) {
                scripts.push(resolvedPath);
            }
        }

        return scripts;
    }

    private shouldIgnoreScript(scriptSrc: string): boolean {
        return this.ignorePatterns.some(pattern => {
            if (pattern.startsWith('http') || pattern.startsWith('https')) {
                return scriptSrc.startsWith(pattern);
            }
            return new RegExp(pattern.replace('*', '.*')).test(scriptSrc);
        });
    }

    private resolveScriptPath(scriptSrc: string, documentUri: vscode.Uri): vscode.Uri | null {
        // 处理根目录别名
        for (const [alias, replacement] of Object.entries(this.rootDirAliases)) {
            if (scriptSrc.startsWith(alias)) {
                scriptSrc = scriptSrc.replace(alias, replacement);
                break;
            }
        }

        // 移除查询参数
        scriptSrc = scriptSrc.split('?')[0];

        if (path.isAbsolute(scriptSrc)) {
            return vscode.Uri.file(scriptSrc);
        }

        const workspaceFolder = vscode.workspace.getWorkspaceFolder(documentUri);
        if (!workspaceFolder) {
            return null;
        }

        const absolutePath = path.resolve(workspaceFolder.uri.fsPath, scriptSrc);
        return vscode.Uri.file(absolutePath);
    }

    private mergeFileInfo(target: FileInfo, source: FileInfo): void {
        for (const [key, value] of Object.entries(source)) {
            if (value instanceof Map) {
                if (!target[key]) {
                    target[key] = new Map();
                }
                const targetMap = target[key] as Map<string, AngularDefinition>;
                for (const [k, v] of value) {
                    targetMap.set(k, v);
                }
            } else if (Array.isArray(value)) {
                if (!target[key]) {
                    target[key] = [];
                }
                const targetArray = target[key] as string[];
                targetArray.push(...value);
            }
        }
    }

    private parseStyles(content: string, fileInfo: FileInfo): void {
        const styleRegex = /<style[^>]*>([\s\S]*?)<\/style>/gi;
        let match;
        while ((match = styleRegex.exec(content)) !== null) {
            const styleContent = match[1];
            const styleStart = match.index + match[0].indexOf('>') + 1;
            this.parseStyleContent(styleContent, styleStart, fileInfo);
        }
    }

    private parseStyleContent(styleContent: string, styleStart: number, fileInfo: FileInfo): void {
        const selectorRegex = /([.#][^\s{]+)\s*{/g;
        let match;
        while ((match = selectorRegex.exec(styleContent)) !== null) {
            const selector = match[1];
            const position = styleStart + match.index;
            fileInfo.styles.set(selector, {
                name: selector,
                position: position,
                type: 'style'
            });
        }
    }

    /**
     * 创建空的文件信息对象
     * @private
     * @returns {FileInfo} 空的文件信息对象
     */
    private createEmptyFileInfo(): FileInfo {
        return {
            components: new Map(),
            controllers: new Map(),
            services: new Map(),
            directives: new Map(),
            functions: new Map(),
            scopeVariables: new Map(),
            ngAttributes: new Map(),
            ngDirectives: [],
            ngControllers: new Map(),
            styles: new Map(),
        };
    }

    /**
     * 获取指定文件的解析信息
     * @param {string} fileName - 文件名
     * @returns {FileInfo | undefined} 文件信息对象,如果文件未解析则返回 undefined
     */
    public getFileInfo(fileName: string): FileInfo | undefined {
        return this.fileMap.get(fileName);
    }

    /**
     * 获取所有已解析文件的文件名列表
     * @returns {string[]} 已解析文件的文件名数组
     */
    public getAllParsedFiles(): string[] {
        return Array.from(this.fileMap.keys());
    }

    public getAssociatedJsFiles(htmlFilePath: string): string[] {
        return this.htmlToJsMap.get(htmlFilePath) || [];
    }

    public getAssociatedHtmlFiles(jsFilePath: string): string[] {
        return this.jsToHtmlMap.get(jsFilePath) || [];
    }

    private shouldIgnoreFile(filePath: string): boolean {
        return this.ignorePatterns.some(pattern => {
            const regexPattern = new RegExp(pattern.replace(/\*/g, '.*'));
            return regexPattern.test(filePath);
        });
    }

    /**
     * 获取默认的排除模式
     * @returns {string[]} 默认排除模式的数组
     */
    public static getDefaultExcludePatterns(): string[] {
        return [
            '.git/**',
            '.history/**',
            '.idea/**',
            '.vscode/**',
            'doc/**'
        ];
    }
}