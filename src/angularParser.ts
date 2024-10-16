/* eslint-disable curly */
import * as fs from 'fs';
import LRUCache from 'lru-cache';
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
 * NgRepeat 表达式接口
 * @interface NgRepeatExpression
 */
export interface NgRepeatExpression {
    position: number;
    variables: string[];
}

/**
 * 文件信息接口
 * @interface FileInfo
 */
export interface FileInfo {
    controllers: Map<string, AngularDefinition>;
    services: Map<string, AngularDefinition>;
    directives: Map<string, AngularDefinition>;
    functions: Map<string, AngularDefinition>;
    scopeVariables: Map<string, AngularDefinition>;
    components: Map<string, AngularDefinition>;
    ngAttributes: Map<string, AngularDefinition>;
    ngControllers: Map<string, AngularDefinition>;
    ngRepeatVariables: Map<string, NgRepeatExpression>;
    filters: Map<string, AngularDefinition>; // 新增
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
    private mockWorkspacePath: string | null = null;
    private resolvedPathCache: LRUCache<string, vscode.Uri | null>;

    /**
     * 创建 AngularParser 的实例
     * 初始化解析器的各设置，包括缓存大小、忽略模式等。
     */
    constructor() {
        const config = vscode.workspace.getConfiguration('angularHelper');
        this.maxConcurrentParsing = config.get<number>('maxConcurrentParsing') || 5;
        const maxCachedFiles = config.get<number>('maxCachedFiles') || 100;
        const cacheTTL = config.get<number>('cacheTTL') || 60 * 60 * 1000; // 默认1小时,单位毫秒

        this.fileMap = new LRUCache<string, FileInfo>({
            max: maxCachedFiles,
            ttl: cacheTTL
        });

        this.rootDirAliases = config.get<{ [key: string]: string }>('rootDirAliases') || {};
        this.ignorePatterns = config.get<string[]>('ignorePatterns') || [];

        const resolvedPathCacheSize = config.get<number>('resolvedPathCacheSize') || 1000;
        const resolvedPathCacheTTL = config.get<number>('resolvedPathCacheTTL') || 3600000; // 默认1小时

        this.resolvedPathCache = new LRUCache<string, vscode.Uri | null>({
            max: resolvedPathCacheSize,
            ttl: resolvedPathCacheTTL
        });

        log(`初始化 AngularParser，忽略模式: ${this.ignorePatterns.join(', ')}`);
        log(`Root dir aliases: ${JSON.stringify(this.rootDirAliases)}`);
        log(`初始化路径解析缓存，大小: ${resolvedPathCacheSize}, TTL: ${resolvedPathCacheTTL}ms`);
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

            log(`开始解析 JavaScript 文件: ${document.fileName}`);

            const visit = (node: ts.Node) => {
                this.parseNode(node, fileInfo);
                ts.forEachChild(node, visit);
            };

            ts.forEachChild(sourceFile, visit);

            // 添加简洁的摘要日志
            log(`文件解析摘要 - ${document.fileName}:`);
            log(`  模块: ${fileInfo.components.size}`);
            log(`  控制器: ${fileInfo.controllers.size}`);
            log(`  服务: ${fileInfo.services.size}`);
            log(`  指令: ${fileInfo.directives.size}`);
            log(`  函数: ${fileInfo.functions.size}`);

            return fileInfo;
        } catch (error) {
            logError(`解析 JavaScript 文件 ${document.fileName} 时出错:`, error);
            return this.createEmptyFileInfo();
        }
    }

    private parseNode(node: ts.Node, fileInfo: FileInfo): void {
        if (ts.isVariableStatement(node)) {
            this.parseVariableStatement(node, fileInfo);
        } else if (ts.isFunctionDeclaration(node)) {
            this.parseFunctionDeclaration(node, fileInfo);
        } else if (ts.isExpressionStatement(node)) {
            this.parseExpressionStatement(node, fileInfo);
        } else if (ts.isPropertyAccessExpression(node)) {
            this.parsePropertyAccessExpression(node, fileInfo);
        } else if (ts.isCallExpression(node)) {
            this.parseCallExpression(node, fileInfo);
        }
    }

    /**
     * 解析表达式语句
     * 此方法用于解析Angular模块和控制器的定义
     * @private
     * @param {ts.ExpressionStatement} node - 表达式语句节点
     * @param {FileInfo} fileInfo - 文件信息对象
     */
    private parseExpressionStatement(node: ts.ExpressionStatement, fileInfo: FileInfo): void {
        if (ts.isCallExpression(node.expression)) {
            const callExpression = node.expression;
            if (ts.isPropertyAccessExpression(callExpression.expression)) {
                const propertyAccess = callExpression.expression;
                const methodName = propertyAccess.name.text;

                if (callExpression.arguments.length > 0 && ts.isStringLiteral(callExpression.arguments[0])) {
                    const name = callExpression.arguments[0].text;
                    const position = node.getStart();

                    switch (methodName) {
                        case 'controller':
                            fileInfo.controllers.set(name, { name, position, type: 'controller' });
                            break;
                        case 'service':
                        case 'factory':
                            fileInfo.services.set(name, { name, position, type: methodName });
                            break;
                        case 'directive':
                            fileInfo.directives.set(name, { name, position, type: 'directive' });
                            break;
                        case 'component':
                            fileInfo.components.set(name, { name, position, type: 'component' });
                            break;
                        case 'filter':
                            fileInfo.filters.set(name, { name, position, type: 'filter' });
                            break;
                    }
                }
            }
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
            
            log(`开始解析 HTML 文件: ${document.fileName}`);

            const scriptRegex = /<script\s+(?:[^>]*?\s+)?src=["']([^"']+)["'][^>]*>/g;
            let match;
            while ((match = scriptRegex.exec(content)) !== null) {
                const scriptSrc = match[1];
                if (!this.shouldIgnoreScript(scriptSrc)) {
                    this.updateScriptMaps(scriptSrc, document.uri);
                }
            }

            const importedScripts = this.findImportedScripts(content, document.uri);
            for (const scriptUri of importedScripts) {
                try {
                    if (await this.fileExists(scriptUri)) {
                        const scriptDocument = await vscode.workspace.openTextDocument(scriptUri);
                        const scriptFileInfo = this.parseJavaScriptFile(scriptDocument);
                        this.mergeFileInfo(fileInfo, scriptFileInfo);
                    }
                } catch (error) {
                    logError(`解析导入的脚本文件 ${scriptUri.fsPath} 时出错:`, error);
                }
            }

            // 始终解析内联 JavaScript
            const inlineScripts = this.extractInlineScripts(content);
            for (const script of inlineScripts) {
                const scriptFileInfo = this.parseJavaScriptContent(script, document.uri);
                this.mergeFileInfo(fileInfo, scriptFileInfo);
            }

            this.parseNgAttributes(content, fileInfo);
            this.parseNgRepeat(content, fileInfo);

            log(`解析到的 ng-* 属性数量: ${fileInfo.ngAttributes.size}`);
            log(`成功解析文件: ${document.fileName}`);
            return fileInfo;
        } catch (error) {
            logError(`解析 HTML 文件 ${document.fileName} 时出错:`, error);
            return this.createEmptyFileInfo();
        }
    }

    private extractInlineScripts(content: string): string[] {
        const scriptRegex = /<script\b[^>]*>([\s\S]*?)<\/script>/gm;
        const scripts: string[] = [];
        let match;
        while ((match = scriptRegex.exec(content)) !== null) {
            scripts.push(match[1]);
        }
        return scripts;
    }

    private parseJavaScriptContent(content: string, documentUri: vscode.Uri): FileInfo {
        const sourceFile = ts.createSourceFile(
            'inline.js',
            content,
            ts.ScriptTarget.Latest,
            true
        );
        const fileInfo = this.createEmptyFileInfo();
        this.parseNode(sourceFile, fileInfo);
        return fileInfo;
    }

    private updateScriptMaps(scriptSrc: string, documentUri: vscode.Uri): void {
        const resolvedPath = this.resolveScriptPath(scriptSrc, documentUri);
        if (resolvedPath) {
            const fileName = path.basename(resolvedPath.fsPath);
            if (!this.htmlToJsMap.has(documentUri.fsPath)) {
                this.htmlToJsMap.set(documentUri.fsPath, []);
            }
            this.htmlToJsMap.get(documentUri.fsPath)!.push(fileName);
            
            if (!this.jsToHtmlMap.has(resolvedPath.fsPath)) {
                this.jsToHtmlMap.set(resolvedPath.fsPath, []);
            }
            this.jsToHtmlMap.get(resolvedPath.fsPath)!.push(documentUri.fsPath);
        }
    }

    private parseNgAttributes(content: string, fileInfo: FileInfo): void {
        const ngAttributeRegex = /\bng-([a-zA-Z-]+)(?:=["']([^"']*)?["'])?/g;
        let match;
        while ((match = ngAttributeRegex.exec(content)) !== null) {
            const attrName = match[1];
            const attrValue = match[2] || '';
            fileInfo.ngAttributes.set(attrName, {
                name: attrName,
                position: match.index,
                type: 'ngAttribute',
                value: attrValue
            });
        }

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
    }

    private parseNgRepeat(content: string, fileInfo: FileInfo) {
        const ngRepeatRegex = /ng-repeat\s*=\s*["'](.+?)\s+in\s+.+?["']/g;
        let match;
        while ((match = ngRepeatRegex.exec(content)) !== null) {
            const variables = match[1].split(',').map(v => v.trim());
            fileInfo.ngRepeatVariables.set(match[0], {
                position: match.index,
                variables: variables
            });
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

    private shouldIgnoreFile(filePath: string): boolean {
        return this.matchesIgnorePattern(filePath);
    }

    private shouldIgnoreScript(scriptSrc: string): boolean {
        return this.matchesIgnorePattern(scriptSrc);
    }

    private matchesIgnorePattern(path: string): boolean {
        return this.ignorePatterns.some(pattern => {
            const regex = new RegExp(this.convertGlobToRegExp(pattern));
            return regex.test(path);
        });
    }

    private convertGlobToRegExp(pattern: string): string {
        return pattern
            .replace(/\./g, '\\.')
            .replace(/\*\*/g, '.*')
            .replace(/\*/g, '[^/]*')
            .replace(/\?/g, '.')
            .replace(/\//g, '\\/');
    }

    private resolveScriptPath(scriptSrc: string, documentUri: vscode.Uri): vscode.Uri | null {
        if (this.shouldIgnoreScript(scriptSrc)) {
            return null;
        }

        const cacheKey = `${documentUri.toString()}:${scriptSrc}`;
        const cachedResult = this.resolvedPathCache.get(cacheKey);
        if (cachedResult !== undefined) {
            return cachedResult;
        }

        let resolvedPath: string = scriptSrc;

        // 处理根目录别名
        for (const [alias, replacement] of Object.entries(this.rootDirAliases)) {
            if (scriptSrc.startsWith(alias)) {
                resolvedPath = scriptSrc.replace(alias, replacement);
                break;
            }
        }

        // 移除查询参数
        resolvedPath = resolvedPath.split('?')[0];

        const basePath = this.getWorkspacePath(documentUri);
        const documentDir = path.dirname(documentUri.fsPath);

        // 处理相对路径
        if (resolvedPath.startsWith('./') || resolvedPath.startsWith('../')) {
            // 相对于当前文档的路径
            resolvedPath = path.resolve(documentDir, resolvedPath);
        } else if (!path.isAbsolute(resolvedPath)) {
            // 如果不是绝对路径，也不是明确的相对路径，先尝试相对于当前文档解析
            let tempPath = path.resolve(documentDir, resolvedPath);
            if (fs.existsSync(tempPath)) {
                resolvedPath = tempPath;
            } else {
                // 如果相对于当前文档不存在，则尝试相对于工作区根目录解析
                resolvedPath = path.resolve(basePath, resolvedPath);
            }
        }

        // 确保使用正确的路径分隔符
        resolvedPath = path.normalize(resolvedPath).replace(/\\/g, '/');

        // 检查文件是否存在
        if (!fs.existsSync(resolvedPath)) {
            log(`警告: 无法找到文件 ${resolvedPath}`);
            this.resolvedPathCache.set(cacheKey, null);
            return null;
        }

        const result = vscode.Uri.file(resolvedPath);
        this.resolvedPathCache.set(cacheKey, result);
        return result;
    }

    private getWorkspacePath(documentUri: vscode.Uri): string {
        if (this.mockWorkspacePath) {
            return this.mockWorkspacePath;
        }
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(documentUri);
        if (workspaceFolder) {
            return workspaceFolder.uri.fsPath;
        }
        // 如果找不到工作区文件夹，使用文档所在目录作为基准
        return path.dirname(documentUri.fsPath);
    }

    private mergeFileInfo(target: FileInfo, source: FileInfo): void {
        for (const key of Object.keys(source) as (keyof FileInfo)[]) {
            const sourceValue = source[key];
            if (sourceValue instanceof Map) {
                if (!target[key]) {
                    target[key] = new Map();
                }
                const targetMap = target[key] as Map<string, AngularDefinition | NgRepeatExpression>;
                for (const [k, v] of sourceValue) {
                    targetMap.set(k, v);
                }
            }
        }
    }

    /**
     * 创空的文件信息对象
     * @private
     * @returns {FileInfo} 空的文件信息对象
     */
    private createEmptyFileInfo(): FileInfo {
        return {
            controllers: new Map(),
            services: new Map(),
            directives: new Map(),
            functions: new Map(),
            scopeVariables: new Map(),
            components: new Map(),
            ngAttributes: new Map(),
            ngControllers: new Map(),
            ngRepeatVariables: new Map(),
            filters: new Map() // 新增
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
     * @returns {string[]} 已解析文件的件名数组
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

    private shouldIgnoreFolder(folderPath: string): boolean {
        return this.ignorePatterns.some(pattern => {
            const regex = new RegExp(`(^|/)${this.convertGlobToRegExp(pattern)}(/|$)`);
            return regex.test(folderPath);
        });
    }

    // 添加这个新方法来检查文件是否存在
    private async fileExists(fileUri: vscode.Uri): Promise<boolean> {
        try {
            await vscode.workspace.fs.stat(fileUri);
            return true;
        } catch {            return false;
        }
    }

    // 用于测试的方法，允许设置模拟的工作区路径
    public setMockWorkspacePath(mockPath: string | null): void {
        this.mockWorkspacePath = mockPath;
    }

    /**
     * 优先解析当前打开的文件
     * @param {vscode.TextDocument} document - 当前打开的文档
     */
    public async prioritizeCurrentFile(document: vscode.TextDocument): Promise<void> {
        log(`优先解析当前打开的文件: ${document.fileName}`);
        
        if (['html', 'javascript'].includes(document.languageId)) {
            await this.parseFile(document.uri);

            if (document.languageId === 'html') {
                // 如果是 HTML 文件，还需要解析关联的 JS 文件
                const associatedJsFiles = this.getAssociatedJsFiles(document.fileName);
                for (const jsFile of associatedJsFiles) {
                    const jsUri = vscode.Uri.file(jsFile);
                    await this.parseFile(jsUri);
                }
            } else if (document.languageId === 'javascript') {
                // 如果是 JS 文件，解析关联的 HTML 文件
                const associatedHtmlFiles = this.getAssociatedHtmlFiles(document.fileName);
                for (const htmlFile of associatedHtmlFiles) {
                    const htmlUri = vscode.Uri.file(htmlFile);
                    await this.parseFile(htmlUri);
                }
            }
        }
    }

    // 新增方法来解析属性访问表达式
    private parsePropertyAccessExpression(node: ts.PropertyAccessExpression, fileInfo: FileInfo): void {
        const expression = node.expression.getText();
        const propertyName = node.name.text;
        
        if (expression === '$scope') {
            fileInfo.scopeVariables.set(propertyName, {
                name: propertyName,
                position: node.getStart(),
                type: 'scopeVariable'
            });
        }
    }

    // 新增方法来解析调用表达式
    private parseCallExpression(node: ts.CallExpression, fileInfo: FileInfo): void {
        if (ts.isPropertyAccessExpression(node.expression)) {
            const objectName = node.expression.expression.getText();
            const methodName = node.expression.name.text;
            
            if (objectName === 'angular' && methodName === 'module') {
                if (node.arguments.length > 0 && ts.isStringLiteral(node.arguments[0])) {
                    const moduleName = node.arguments[0].text;
                    fileInfo.components.set(moduleName, {
                        name: moduleName,
                        position: node.getStart(),
                        type: 'module'
                    });
                }
            }
        }
    }

    /**
     * 更新单个文件的索引
     * @param {vscode.Uri} fileUri - 要更新的文件URI
     * @returns {Promise<void>}
     */
    public async updateFileIndex(fileUri: vscode.Uri): Promise<void> {
        const filePath = fileUri.fsPath;
        const fileExtension = path.extname(filePath).toLowerCase();

        try {
            log(`开始更新文件索引: ${filePath}`);

            if (!await this.fileExists(fileUri)) {
                throw new Error(`文件不存在: ${filePath}`);
            }

            if (fileExtension === '.html') {
                await this.updateHtmlFileIndex(fileUri);
            } else if (fileExtension === '.js') {
                await this.updateJsFileIndex(fileUri);
            } else {
                throw new Error(`不支持的文件类型: ${fileExtension}, 文件: ${filePath}`);
            }

            log(`文件索引更新完成: ${filePath}`);
        } catch (error) {
            logError(`更新文件索引时出错 ${filePath}:`, error);
            throw error; // 重新抛出错误,以便调用者可以处理
        }
    }

    /**
     * 更新HTML文件的索引
     * @param {vscode.Uri} fileUri - HTML文件的URI
     * @returns {Promise<void>}
     */
    private async updateHtmlFileIndex(fileUri: vscode.Uri): Promise<void> {
        const filePath = fileUri.fsPath;
        try {
            const document = await vscode.workspace.openTextDocument(fileUri);

            // 清除旧的关联
            this.htmlToJsMap.delete(filePath);
            for (const [jsFile, htmlFiles] of this.jsToHtmlMap.entries()) {
                const index = htmlFiles.indexOf(filePath);
                if (index !== -1) {
                    htmlFiles.splice(index, 1);
                    if (htmlFiles.length === 0) {
                        this.jsToHtmlMap.delete(jsFile);
                    }
                }
            }

            // 重新分析HTML文件
            await this.analyzeHtmlFile(fileUri);

            // 更新文件信息
            const fileInfo = await this.parseHtmlFile(document);
            this.fileMap.set(filePath, fileInfo);
        } catch (error) {
            logError(`更新HTML文件索引时出错 ${filePath}:`, error);
            throw error;
        }
    }

    /**
     * 更新JavaScript文件的索引
     * @param {vscode.Uri} fileUri - JavaScript文件的URI
     * @returns {Promise<void>}
     */
    private async updateJsFileIndex(fileUri: vscode.Uri): Promise<void> {
        const filePath = fileUri.fsPath;
        try {
            const document = await vscode.workspace.openTextDocument(fileUri);

            // 更新文件信息
            const fileInfo = this.parseJavaScriptFile(document);
            this.fileMap.set(filePath, fileInfo);

            // 更新关联的HTML文件
            const associatedHtmlFiles = this.jsToHtmlMap.get(filePath) || [];
            for (const htmlFile of associatedHtmlFiles) {
                await this.updateHtmlFileIndex(vscode.Uri.file(htmlFile)).catch(error => {
                    logError(`更新关联的HTML文件时出错 ${htmlFile}:`, error);
                });
            }
        } catch (error) {
            logError(`更新JavaScript文件索引时出错 ${filePath}:`, error);
            throw error;
        }
    }
}