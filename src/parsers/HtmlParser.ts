/* eslint-disable curly */
import * as vscode from 'vscode';
import { FileInfo } from '../types/types';
import { FileUtils } from '../utils/FileUtils';
import { PathResolver } from '../utils/PathResolver';
import { JavaScriptParser } from './JavaScriptParser';

export class HtmlParser {
    private config !: vscode.WorkspaceConfiguration;
    private pathResolver: PathResolver;
    private jsParser: JavaScriptParser;
    private parsingFiles: Set<string> = new Set();

    constructor(config: vscode.WorkspaceConfiguration, pathResolver: PathResolver) {
        this.updateConfiguration(config);
        this.pathResolver = pathResolver;
        this.jsParser = new JavaScriptParser();
    }

    public updateConfiguration(config: vscode.WorkspaceConfiguration): void {
        this.config = config;
    }

    public async parseHtmlFile(document: vscode.TextDocument): Promise<{ fileInfo: FileInfo, associatedJsFiles: string[] }> {
        const filePath = document.uri.fsPath;
        if (this.parsingFiles.has(filePath)) {
            FileUtils.logDebugForAssociations(`跳过正在解析的HTML文件: ${filePath}`);
            return { fileInfo: this.createEmptyFileInfo(document), associatedJsFiles: [] };
        }

        this.parsingFiles.add(filePath);
        FileUtils.logDebugForAssociations(`开始解析HTML文件: ${filePath}`);

        try {
            const fileInfo: FileInfo = this.createEmptyFileInfo(document);
            const content = document.getText();

            // 首先解析关联的JS文件
            const associatedJsFiles = await this.parseHtmlForJsFiles(document);
            FileUtils.logDebugForAssociations(`HTML文件 ${filePath} 关联的JS文件: ${associatedJsFiles.join(', ')}`);

            // 然后解析HTML内容
            this.parseNgAttributes(document, content, fileInfo);
            this.parseInlineJavaScript(document, content, fileInfo);
            this.parseAngularExpressions(document, content, fileInfo);

            return { fileInfo, associatedJsFiles };
        } finally {
            this.parsingFiles.delete(filePath);
        }
    }

    public async parseHtmlForJsFiles(document: vscode.TextDocument): Promise<string[]> {
        FileUtils.logDebugForAssociations(`开始解析HTML文件以查找关联的JS文件: ${document.uri.fsPath}`);
        const content = document.getText();
        const scriptRegex = /<script\s+(?:[^>]*?\s+)?src=["']([^"']+)["'][^>]*>/g;
        const jsFiles: string[] = [];
        let match;
        while ((match = scriptRegex.exec(content)) !== null) {
            const scriptSrc = match[1];
            FileUtils.logDebugForAssociations(`找到script标签，src属性值: ${scriptSrc}`);
            const resolvedPath = this.pathResolver.resolveScriptPath(scriptSrc, document.uri);
            if (resolvedPath) {
                FileUtils.logDebugForAssociations(`解析后的JS文件路径: ${resolvedPath.fsPath}`);
                jsFiles.push(resolvedPath.fsPath);
            }
        }

        return jsFiles;
    }

    private parseNgAttributes(document: vscode.TextDocument, content: string, fileInfo: FileInfo): void {
        const ngDirectiveRegex = /ng-(\w+)\s*=\s*["'](.+?)["']/g;
        let match;
        while ((match = ngDirectiveRegex.exec(content)) !== null) {
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
    }

    private extractFunctionReferences(document: vscode.TextDocument, value: string, fileInfo: FileInfo, startIndex: number): void {
        const functionNameRegex = /\b([a-zA-Z_$][a-zA-Z0-9_$]*)(?:\s*\(|\s*&&|\s*\|\||\s*\?|\s*:|\s*$)/g;
        let functionMatch;
        while ((functionMatch = functionNameRegex.exec(value)) !== null) {
            const functionName = functionMatch[1];
            // 忽略数字和 JavaScript 关键字
            if (!this.shouldIgnoreReference(functionName)) {
                const position = document.offsetAt(document.positionAt(startIndex + functionMatch.index));
                this.addFunctionToFileInfo(fileInfo, functionName, position, false);
                FileUtils.logDebugForFindDefinitionAndReference(`在HTML中找到函数或变量引用: ${functionName}, 位置: ${document.uri.fsPath}, 行 ${document.positionAt(position).line + 1}, 列 ${document.positionAt(position).character + 1}`);
            }
        }
    }

    private shouldIgnoreReference(name: string): boolean {
        // 忽略数字
        if (/^\d+$/.test(name)) return true;

        // 忽略 JavaScript 关键字和常见的全局对象
        const ignoreList = [
            'undefined', 'null', 'true', 'false',
            'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break',
            'continue', 'return', 'try', 'catch', 'finally', 'throw',
            'var', 'let', 'const',
            'function', 'class',
            'this', 'super',
            'Object', 'Array', 'String', 'Number', 'Boolean', 'Function',
            'Math', 'Date', 'RegExp', 'Error', 'JSON'
        ];

        return ignoreList.includes(name);
    }

    private parseInlineJavaScript(document: vscode.TextDocument, content: string, fileInfo: FileInfo): void {
        const scriptRegex = /<script\s*>([\s\S]*?)<\/script>/g;
        let match;
        while ((match = scriptRegex.exec(content)) !== null) {
            const scriptContent = match[1];
            // 使用 JavaScriptParser 来解析内联 JavaScript
            this.jsParser.parseJavaScriptContent(scriptContent, fileInfo, document);
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

    private createEmptyFileInfo(document: vscode.TextDocument): FileInfo {
        return {
            filePath: document.uri.fsPath,
            controllers: new Map(),
            services: new Map(),
            directives: new Map(),
            functions: new Map(),
            scopeVariables: new Map(),
            components: new Map(),
            ngAttributes: new Map(),
            ngControllers: new Map(),
            ngRepeatVariables: new Map(),
            filters: new Map()
        };
    }

    private parseAngularExpressions(document: vscode.TextDocument, content: string, fileInfo: FileInfo): void {
        // 解析 {{expression}} 中的表达式
        const expressionRegex = /{{(.+?)}}/g;
        let match;
        while ((match = expressionRegex.exec(content)) !== null) {
            const expression = match[1];
            this.extractFunctionReferences(document, expression, fileInfo, match.index + 2);  // +2 to skip {{
            this.extractFilterReferences(document, expression, fileInfo, match.index + 2);
        }

        // 解析 ng-bind 和 ng-bind-html 属性中的表达式
        const ngBindRegex = /ng-bind(?:-html)?\s*=\s*["']([^"']+)["']/g;
        while ((match = ngBindRegex.exec(content)) !== null) {
            const expression = match[1];
            const startIndex = match.index + match[0].indexOf(expression);
            this.extractFunctionReferences(document, expression, fileInfo, startIndex);
            this.extractFilterReferences(document, expression, fileInfo, startIndex);
        }

        // 解析其他 ng-* 指令中的表达式
        const directiveRegex = /ng-(if|show|hide|class|style)\s*=\s*["'](.+?)["']/g;
        while ((match = directiveRegex.exec(content)) !== null) {
            const expression = match[2];
            const startIndex = match.index + match[0].indexOf(expression);
            this.extractFunctionReferences(document, expression, fileInfo, startIndex);
        }
    }

    private extractFilterReferences(document: vscode.TextDocument, expression: string, fileInfo: FileInfo, startIndex: number): void {
        const filterRegex = /\|\s*(\w+)/g;
        let filterMatch;
        while ((filterMatch = filterRegex.exec(expression)) !== null) {
            const filterName = filterMatch[1];
            const position = document.offsetAt(document.positionAt(startIndex + filterMatch.index + filterMatch[0].indexOf(filterName)));
            
            // 添加 filter 引用
            if (!fileInfo.filters.has(filterName)) {
                fileInfo.filters.set(filterName, []);
            }
            fileInfo.filters.get(filterName)!.push({
                name: filterName,
                position,
                type: 'filter',
                isDefinition: false
            });

            FileUtils.logDebugForFindDefinitionAndReference(
                `找到 filter 引用: ${filterName}, 位置: ${document.fileName}, ` +
                `行 ${document.positionAt(position).line + 1}, ` +
                `列 ${document.positionAt(position).character + 1}`
            );
        }
    }
}
