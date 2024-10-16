/* eslint-disable curly */
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
    private mockWorkspacePath: string | null = null;

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
            '__ROOT__': './',
            '__PUBLIC__': './Public'
        });
        this.ignorePatterns = config.get<string[]>('ignoreScriptPatterns', [
            '*.min.js',
            'http://*',
            'https://*'
        ]);

        // 添加默认忽略的文件夹
        this.ignorePatterns.push(...AngularParser.getDefaultExcludePatterns());

        log(`初始化 AngularParser，忽略模式: ${this.ignorePatterns.join(', ')}`);
        log(`Root dir aliases: ${JSON.stringify(this.rootDirAliases)}`);
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

            ts.forEachChild(sourceFile, node => {
                if (ts.isVariableStatement(node)) {
                    this.parseVariableStatement(node, fileInfo);
                } else if (ts.isFunctionDeclaration(node)) {
                    this.parseFunctionDeclaration(node, fileInfo);
                } else if (ts.isExpressionStatement(node)) {
                    this.parseExpressionStatement(node, fileInfo);
                }
            });

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

    /**
     * 解析表达式语句
     * 此方法用于解析Angular模块和控制器的定义
     * @private
     * @param {ts.ExpressionStatement} node - 表达式语句节点
     * @param {FileInfo} fileInfo - 文件信息对象
     */
    private parseExpressionStatement(node: ts.ExpressionStatement, fileInfo: FileInfo): void {
        if (!ts.isCallExpression(node.expression)) return;

        const callExpression = node.expression;
        if (ts.isPropertyAccessExpression(callExpression.expression)) {
            const propertyAccess = callExpression.expression;
            const firstArgument = callExpression.arguments[0];

            if (firstArgument && ts.isStringLiteral(firstArgument)) {
                const name = firstArgument.text;
                const position = node.getStart();
                const type = propertyAccess.name.text;

                const definition: AngularDefinition = { name, position, type };

                switch (type) {
                    case 'module':
                        log(`发现 Angular 模块: ${name}`);
                        fileInfo.components.set(name, definition);
                        break;
                    case 'controller':
                        log(`发现控制器: ${name}`);
                        fileInfo.controllers.set(name, definition);
                        break;
                    case 'service':
                    case 'factory':
                        log(`发现服务/工厂: ${name}`);
                        fileInfo.services.set(name, definition);
                        break;
                    case 'directive':
                        log(`发现指令: ${name}`);
                        fileInfo.directives.set(name, definition);
                        break;
                    case 'component':
                        log(`发现组件: ${name}`);
                        fileInfo.components.set(name, definition);
                        break;
                }
            }
        } else if (ts.isIdentifier(callExpression.expression) && callExpression.expression.text === 'angular') {
            // 处理 angular.module('moduleName', []) 的情况
            const firstArgument = callExpression.arguments[0];
            if (firstArgument && ts.isStringLiteral(firstArgument)) {
                const name = firstArgument.text;
                const position = node.getStart();
                const definition: AngularDefinition = { name, position, type: 'module' };
                log(`发现 Angular 模块: ${name}`);
                fileInfo.components.set(name, definition);
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

            this.parseNgAttributes(content, fileInfo);

            log(`解析到的 ng-* 属性数量: ${fileInfo.ngAttributes.size}`);
            log(`成功解析文件: ${document.fileName}`);
            return fileInfo;
        } catch (error) {
            logError(`解析 HTML 文件 ${document.fileName} 时出错:`, error);
            return this.createEmptyFileInfo();
        }
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

        fileInfo.ngDirectives = content.match(/ng-[a-zA-Z]+="([^"]+)"/g) || [];

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
        for (const pattern of this.ignorePatterns) {
            const regex = this.createRegexFromPattern(pattern);
            if (regex.test(scriptSrc)) {
                return true;
            }
        }
        return false;
    }

    private createRegexFromPattern(pattern: string): RegExp {
        let regexPattern = pattern
            .replace(/\./g, '\\.')
            .replace(/\*\*/g, '.*')
            .replace(/\*/g, '[^/]*');

        if (pattern.startsWith('http://') || pattern.startsWith('https://')) {
            regexPattern = `^${regexPattern}`;
        } else {
            regexPattern = `(^|/)${regexPattern}($|/)`;
        }

        return new RegExp(regexPattern);
    }

    private resolveScriptPath(scriptSrc: string, documentUri: vscode.Uri): vscode.Uri | null {
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

        // 如果是相对路径，则相对于基准路径解析
        if (!path.isAbsolute(resolvedPath)) {
            resolvedPath = path.resolve(basePath, resolvedPath);
        } else {
            // 如果是绝对路径，则直接使用，但确保使用正确的分隔符
            resolvedPath = path.normalize(resolvedPath).replace(/\\/g, '/');
        }

        return vscode.Uri.file(resolvedPath);
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
            // 将通配符模式转换为正则表达式
            const regexPattern = pattern
                .replace(/\./g, '\\.')  // 转义点号
                .replace(/\*\*/g, '.*')  // 将 ** 转换为 .*
                .replace(/\*/g, '[^/]*');  // 将单个 * 转换为 [^/]*
            const regex = new RegExp(`^${regexPattern}$`);
            return regex.test(filePath);
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
}