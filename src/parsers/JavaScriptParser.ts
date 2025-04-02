import * as ts from 'typescript';
import * as vscode from 'vscode';
import { FileInfo } from '../types/types';
import { FileInfoFactory } from '../utils/FileInfoFactory';
import { FileUtils } from '../utils/FileUtils';
import { PathResolver } from '../utils/PathResolver';
import { ParserBase } from './ParserBase';

export class JavaScriptParser extends ParserBase {
    private readonly PARSE_TIMEOUT = 5000; // 5秒解析超时
    private readonly CACHE_TTL = 30000; // 30秒缓存过期时间
    private readonly AST_CACHE_SIZE = 100; // 最大缓存 AST 数量

    // AST 缓存
    private astCache = new Map<string, {
        ast: ts.SourceFile;
        timestamp: number;
        hash: string;
    }>();

    // 常用的 Angular 模块方法
    private static readonly ANGULAR_MODULE_METHODS = new Set([
        'controller', 'service', 'factory', 'directive', 'filter', 'component'
    ]);

    private pathResolver: PathResolver | null = null;
    private initialized = false;

    constructor(pathResolver?: PathResolver) {
        super();
        this.pathResolver = pathResolver || null;
    }

    public initialize(config: vscode.WorkspaceConfiguration): void {
        if (this.initialized) return;
        
        if (!this.pathResolver) {
            this.pathResolver = new PathResolver(config);
        }
        
        this.initialized = true;
    }

    private ensureInitialized() {
        if (!this.initialized) {
            throw new Error('JavaScriptParser must be initialized with config first');
        }
    }

    public async parseJavaScriptFile(document: vscode.TextDocument): Promise<FileInfo> {
        const filePath = document.uri.fsPath;
        if (this.isFileBeingParsed(filePath)) {
            FileUtils.logDebugForAssociations(`跳过正在解析的JS文件: ${filePath}`);
            return FileInfoFactory.createEmpty(filePath);
        }

        this.markFileAsParsing(filePath);
        try {
            const fileInfo = FileInfoFactory.createEmpty(filePath);
            const content = document.getText();
            const contentHash = this.hashContent(content);

            // 检查缓存
            const cached = this.astCache.get(filePath);
            let sourceFile: ts.SourceFile;

            if (cached && cached.hash === contentHash && (Date.now() - cached.timestamp) < this.CACHE_TTL) {
                sourceFile = cached.ast;
                FileUtils.logDebugForAssociations(`使用缓存的AST: ${filePath}`);
            } else {
                sourceFile = this.createSourceFile(document.fileName, content);
                
                // 更新缓存
                this.astCache.set(filePath, {
                    ast: sourceFile,
                    timestamp: Date.now(),
                    hash: contentHash
                });

                // 清理过期缓存
                this.cleanupASTCache();
            }

            // 使用 Promise.race 添加超时保护
            await Promise.race([
                this.parseNodeWithTimeout(sourceFile, fileInfo, document),
                new Promise((_, reject) => setTimeout(() => reject(new Error('解析超时')), this.PARSE_TIMEOUT))
            ]);

            return fileInfo;
        } catch (error) {
            FileUtils.logError(`解析JavaScript文件失败: ${filePath}`, error);
            return FileInfoFactory.createEmpty(filePath);
        } finally {
            this.markFileAsFinishedParsing(filePath);
        }
    }

    public async parseJavaScriptContent(content: string, fileInfo: FileInfo, document: vscode.TextDocument): Promise<void> {
        FileUtils.logDebugForFindDefinitionAndReference(
            `开始解析JavaScript内容, 文件: ${document.fileName}`
        );

        const scriptStartPosition = this.findScriptPosition(content, document);
        
        try {
            const sourceFile = this.createSourceFile('inline.js', content);

            // 使用 Promise.race 添加超时保护
            await Promise.race([
                this.parseNodeWithTimeout(sourceFile, fileInfo, document, scriptStartPosition),
                new Promise((_, reject) => setTimeout(() => reject(new Error('解析超时')), this.PARSE_TIMEOUT))
            ]);

            FileUtils.logDebugForFindDefinitionAndReference(
                `JavaScript内容解析完成, 找到的函数数量: ${fileInfo.functions.size}, ` +
                `变量数量: ${fileInfo.scopeVariables.size}`
            );
        } catch (error) {
            FileUtils.logError(`解析JavaScript内容时出错: ${error}`, error);
        }
    }

    private createSourceFile(fileName: string, content: string): ts.SourceFile {
        return ts.createSourceFile(
            fileName,
            content,
            ts.ScriptTarget.Latest,
            true
        );
    }

    private async parseNodeWithTimeout(
        node: ts.Node,
        fileInfo: FileInfo,
        document: vscode.TextDocument,
        scriptStartPosition: number = 0
    ): Promise<void> {
        return new Promise<void>((resolve) => {
            this.parseNode(node, fileInfo, document, scriptStartPosition);
            resolve();
        });
    }

    private parseNode(node: ts.Node, fileInfo: FileInfo, document: vscode.TextDocument, scriptStartPosition: number = 0): void {
        try {
            switch (node.kind) {
                case ts.SyntaxKind.VariableStatement:
                    this.handleVariableStatement(fileInfo, node as ts.VariableStatement, scriptStartPosition);
                    break;
                case ts.SyntaxKind.ExpressionStatement:
                    this.handleExpressionStatement(fileInfo, node as ts.ExpressionStatement, document, scriptStartPosition);
                    break;
                case ts.SyntaxKind.CallExpression:
                    this.handleCallExpression(fileInfo, node as ts.CallExpression, document, scriptStartPosition);
                    break;
                default:
            this.findScopeReferences(node, fileInfo, document, scriptStartPosition);
                    break;
            }

            // 递归处理子节点
            node.forEachChild(child => this.parseNode(child, fileInfo, document, scriptStartPosition));
        } catch (error) {
            FileUtils.logError(`解析节点时出错: ${ts.SyntaxKind[node.kind]}`, error);
        }
    }

    private handleExpressionStatement(fileInfo: FileInfo, node: ts.ExpressionStatement, document: vscode.TextDocument, scriptStartPosition: number) {
        if (!ts.isBinaryExpression(node.expression) || node.expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken) {
            return;
        }

        const { left, right } = node.expression;
        
        if (!ts.isPropertyAccessExpression(left)) {
            return;
        }

        const propertyChain = this.buildPropertyChain(left);
        if (!propertyChain.startsWith('$scope.')) {
            return;
        }

                    const position = scriptStartPosition + left.getStart();
        const name = propertyChain.substring(7); // 去掉 '$scope.'
                    
                    if (ts.isFunctionExpression(right) || ts.isArrowFunction(right)) {
            this.addScopeFunction(fileInfo, name, position, true);
                        FileUtils.logDebugForFindDefinitionAndReference(
                `找到 $scope 函数定义: ${name}, 位置: ${document.fileName}, ` +
                            `行 ${document.positionAt(position).line + 1}, ` +
                            `列 ${document.positionAt(position).character + 1}`
                        );
                    } else {
            this.addScopeVariable(fileInfo, name, position, true);
        }
    }

    private buildPropertyChain(node: ts.PropertyAccessExpression): string {
        const parts: string[] = [];
        let current: ts.Expression = node;

        while (ts.isPropertyAccessExpression(current)) {
            if (ts.isIdentifier(current.name)) {
                parts.unshift(current.name.text);
            }
            current = current.expression;
        }

        if (ts.isIdentifier(current)) {
            parts.unshift(current.text);
        }

        return parts.join('.');
    }

    private findScopeReferences(node: ts.Node, fileInfo: FileInfo, document: vscode.TextDocument, scriptStartPosition: number) {
        if (!ts.isPropertyAccessExpression(node)) {
            return;
        }

        const propertyChain = this.buildPropertyChain(node);
        if (!propertyChain.startsWith('$scope.')) {
            return;
        }

        const parts = propertyChain.split('.');
        let partialPath = '';
        
        for (let i = 1; i < parts.length; i++) {
            partialPath = parts.slice(1, i + 1).join('.');
                        const propPosition = scriptStartPosition + node.getStart() + 
                            node.getText().indexOf(partialPath);
                        
                        this.addScopeVariable(fileInfo, partialPath, propPosition, false);
                        
                        FileUtils.logDebugForFindDefinitionAndReference(
                            `找到 $scope 属性链引用: ${partialPath}, 位置: ${document.fileName}, ` +
                            `行 ${document.positionAt(propPosition).line + 1}, ` +
                            `列 ${document.positionAt(propPosition).character + 1}`
                        );
                    }
                }

    private handleCallExpression(fileInfo: FileInfo, node: ts.CallExpression, document: vscode.TextDocument, scriptStartPosition: number) {
        // 处理 Angular 模块方法调用
        if (this.isAngularModuleMethodCall(node)) {
            this.handleAngularModuleMethod(fileInfo, node, document);
        }

        // 处理 filter 定义
        if (this.isFilterDefinition(node)) {
            this.handleFilterDefinition(fileInfo, node, document);
        }

        // 递归处理属性访问
        if (ts.isPropertyAccessExpression(node.expression)) {
            this.findScopeReferences(node.expression, fileInfo, document, scriptStartPosition);
        }

        // 递归处理参数
        node.arguments.forEach(arg => {
            this.findScopeReferences(arg, fileInfo, document, scriptStartPosition);
        });
    }

    private isAngularModuleMethodCall(node: ts.CallExpression): boolean {
        if (!ts.isPropertyAccessExpression(node.expression)) {
            return false;
        }

        const { expression, name } = node.expression;
        return (ts.isIdentifier(expression) && expression.text === 'app' &&
                ts.isIdentifier(name) && JavaScriptParser.ANGULAR_MODULE_METHODS.has(name.text));
    }

    private isFilterDefinition(node: ts.CallExpression): boolean {
        if (!ts.isPropertyAccessExpression(node.expression)) {
            return false;
        }

        const { expression, name } = node.expression;
        return (ts.isIdentifier(expression) && expression.text === 'app' &&
                ts.isIdentifier(name) && name.text === 'filter' &&
                node.arguments.length >= 1 && ts.isStringLiteral(node.arguments[0]));
    }

    private handleAngularModuleMethod(fileInfo: FileInfo, node: ts.CallExpression, document: vscode.TextDocument) {
        if (!ts.isPropertyAccessExpression(node.expression) || node.arguments.length < 1) {
            return;
        }

        const methodName = (node.expression as ts.PropertyAccessExpression).name.text;
        const firstArg = node.arguments[0];

        if (!ts.isStringLiteral(firstArg)) {
            return;
        }

        const name = firstArg.text;
        const position = document.offsetAt(document.positionAt(firstArg.getStart()));

        switch (methodName) {
            case 'controller':
                fileInfo.controllers.set(name, {
                    name,
                    position,
                    type: 'controller',
                    isDefinition: true
                });
                break;
            case 'service':
            case 'factory':
                fileInfo.services.set(name, {
                    name,
                    position,
                    type: 'service',
                    isDefinition: true
                });
                break;
            case 'directive':
                fileInfo.directives.set(name, {
                    name,
                    position,
                    type: 'directive',
                    isDefinition: true
                });
                break;
            case 'component':
                fileInfo.components.set(name, {
                    name,
                    position,
                    type: 'component',
                    isDefinition: true
                });
                break;
        }
    }

    public async parseJavaScriptFileAssociations(document: vscode.TextDocument): Promise<{ associatedHtmlFiles: string[] }> {
        this.ensureInitialized();
        FileUtils.logDebugForAssociations(`快速解析JS文件关联: ${document.uri.fsPath}`);
        const content = document.getText();
        const sourceFile = this.createSourceFile(document.fileName, content);
        const associatedHtmlFiles = new Set<string>();

        // 提取Angular组件/指令名称
        const extractNames = (node: ts.Node) => {
            if (ts.isCallExpression(node) && this.isAngularModuleMethodCall(node)) {
                const methodName = (node.expression as ts.PropertyAccessExpression).name.text;
                const firstArg = node.arguments[0];
                
                if (ts.isStringLiteral(firstArg) && (methodName === 'component' || methodName === 'directive')) {
                    const name = firstArg.text;
                    if (this.pathResolver) {
                        const htmlPath = this.pathResolver.resolveHtmlPath(name, document.uri);
                        if (htmlPath) {
                            associatedHtmlFiles.add(htmlPath.fsPath);
                        }
                    }
                }
            }
            node.forEachChild(extractNames);
        };

        extractNames(sourceFile);
        return { associatedHtmlFiles: Array.from(associatedHtmlFiles) };
    }

    private handleFilterDefinition(fileInfo: FileInfo, node: ts.CallExpression, document: vscode.TextDocument) {
        const filterName = (node.arguments[0] as ts.StringLiteral).text;
                const position = document.offsetAt(document.positionAt(node.arguments[0].getStart()));

                if (!fileInfo.filters.has(filterName)) {
                    fileInfo.filters.set(filterName, []);
                }

                fileInfo.filters.get(filterName)!.push({
                    name: filterName,
                    position,
                    type: 'filter',
                    isDefinition: true
                });
    }

    private handleVariableStatement(
        fileInfo: FileInfo, 
        node: ts.VariableStatement, 
        scriptStartPosition: number
    ): void {
        // 添加最大递归深度限制
        const MAX_RECURSION_DEPTH = 5;
        
        const processDeclaration = (declaration: ts.VariableDeclaration, depth: number = 0) => {
            if (depth >= MAX_RECURSION_DEPTH) {
                FileUtils.logDebugForFindDefinitionAndReference(
                    `达到最大递归深度 ${MAX_RECURSION_DEPTH}，停止处理`
                );
                return;
            }
            
            if (ts.isIdentifier(declaration.name) && declaration.initializer) {
                const name = declaration.name.text;
                const position = scriptStartPosition + declaration.name.getStart();
                
                if (ts.isFunctionExpression(declaration.initializer) || 
                    ts.isArrowFunction(declaration.initializer)) {
                    this.addScopeFunction(fileInfo, name, position, true);
                } else if (ts.isObjectLiteralExpression(declaration.initializer)) {
                    // 处理对象字面量，但限制递归深度
                    declaration.initializer.properties.forEach(prop => {
                        if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
                            const propDeclaration = {
                                name: prop.name,
                                initializer: prop.initializer,
                                getStart: () => prop.name.getStart()
                            } as ts.VariableDeclaration;
                            processDeclaration(propDeclaration, depth + 1);
                        }
                    });
                } else {
                    this.addScopeVariable(fileInfo, name, position, true);
                }
            }
        };

        try {
            node.declarationList.declarations.forEach(declaration => {
                processDeclaration(declaration);
            });
        } catch (error) {
            FileUtils.logError(`处理变量声明时出错: ${error}`, error);
        }
    }

    private addScopeFunction(fileInfo: FileInfo, name: string, position: number, isDefinition: boolean) {
        const normalizedName = name.startsWith('$scope.') ? name.substring(7) : name;
        
        if (!fileInfo.functions.has(normalizedName)) {
            fileInfo.functions.set(normalizedName, []);
        }
        
        fileInfo.functions.get(normalizedName)!.push({
            name: normalizedName,
            position,
            type: 'function',
            isDefinition
        });
    }

    private addScopeVariable(fileInfo: FileInfo, name: string, position: number, isDefinition: boolean) {
        const normalizedName = name.startsWith('$scope.') ? name.substring(7) : name;
        
            fileInfo.scopeVariables.set(normalizedName, {
                name: normalizedName,
                position,
                type: 'variable',
                isDefinition
            });
        }

    private findScriptPosition(scriptContent: string, document: vscode.TextDocument): number {
        const documentContent = document.getText();
        const index = documentContent.indexOf(scriptContent);
        return index >= 0 ? document.offsetAt(document.positionAt(index)) : 0;
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

    private cleanupASTCache(): void {
        const now = Date.now();
        const entries = Array.from(this.astCache.entries());
        
        // 按时间戳排序
        entries.sort((a, b) => b[1].timestamp - a[1].timestamp);
        
        // 保留最新的 AST_CACHE_SIZE 个条目
        if (entries.length > this.AST_CACHE_SIZE) {
            entries.slice(this.AST_CACHE_SIZE).forEach(([key]) => {
                this.astCache.delete(key);
            });
        }

        // 删除过期的条目
        entries.forEach(([key, value]) => {
            if (now - value.timestamp > this.CACHE_TTL) {
                this.astCache.delete(key);
            }
        });
    }
}
