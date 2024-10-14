/* eslint-disable curly */
import { LRUCache } from 'lru-cache';
import * as ts from 'typescript';
import * as vscode from 'vscode';

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
}

/**
 * Angular 解析器类
 * @class AngularParser
 */
export class AngularParser {
    private fileMap: LRUCache<string, FileInfo>;
    private parseQueue: vscode.Uri[] = [];
    private isParsingQueue = false;
    private maxConcurrentParsing: number;

    /**
     * 创建 AngularParser 的实例
     * @constructor
     */
    constructor() {
        const config = vscode.workspace.getConfiguration('angularDefinitionProvider');
        this.maxConcurrentParsing = config.get<number>('maxConcurrentParsing', 5);
        const maxCachedFiles = config.get<number>('maxCachedFiles', 100);
        const cacheTTL = config.get<number>('cacheTTL', 60 * 60 * 1000); // 默认1小时,单位毫秒

        this.fileMap = new LRUCache<string, FileInfo>({
            max: maxCachedFiles,
            ttl: cacheTTL
        });
    }
    
    /**
     * 解析单个文件
     * @param {vscode.Uri} file - 要解析的文件 URI
     * @returns {Promise<void>}
     */
    public async parseFile(file: vscode.Uri): Promise<void> {
        try {
            const document = await vscode.workspace.openTextDocument(file);
            await this.parseFileByType(document);
        } catch (error) {
            console.error(`解析文件 ${file.fsPath} 时出错:`, error);
        }
    }

    /**
     * 处理解析队列
     * @private
     * @returns {Promise<void>}
     */
    private async processQueue(): Promise<void> {
        if (this.isParsingQueue) return;
        this.isParsingQueue = true;

        try {
            while (this.parseQueue.length > 0) {
                const batch = this.parseQueue.splice(0, this.maxConcurrentParsing);
                await Promise.all(batch.map(file => this.parseFile(file)));
            }
        } catch (error) {
            console.error('处理解析队列时出错:', error);
        } finally {
            this.isParsingQueue = false;
        }
    }

    /**
     * 初始化解析器
     * @param {vscode.Uri[]} files - 要解析的文件 URI 数组
     * @returns {Promise<void>}
     */
    public async initializeParser(files: vscode.Uri[]): Promise<void> {
        this.parseQueue = files;
        await this.processQueue();
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

        if (document.languageId === SUPPORTED_LANGUAGES.JAVASCRIPT) {
            fileInfo = this.parseJavaScriptFile(document);
        } else if (document.languageId === SUPPORTED_LANGUAGES.HTML) {
            fileInfo = this.parseHtmlFile(document);
        } else {
            console.warn(`不支持的文件类型: ${document.languageId}`);
            return;
        }

        this.fileMap.set(fileName, fileInfo);
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
            console.error(`解析 JavaScript 文件 ${document.fileName} 时出错:`, error);
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
    private parseHtmlFile(document: vscode.TextDocument): FileInfo {
        try {
            const content = document.getText();
            const ngAttributes = content.match(/\bng-[a-zA-Z-]+="([^"]+)"/g) || [];
            const ngDirectives = content.match(/\*ng[a-zA-Z]+="([^"]+)"/g) || [];
            const ngControllers = content.match(/ng-controller="([^"]+)"/g) || [];
            
            const fileInfo = this.createEmptyFileInfo();
            
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

            fileInfo.ngDirectives = ngDirectives;

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

            return fileInfo;
        } catch (error) {
            console.error(`解析 HTML 文件 ${document.fileName} 时出错:`, error);
            return this.createEmptyFileInfo();
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
            ngControllers: new Map()
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
}