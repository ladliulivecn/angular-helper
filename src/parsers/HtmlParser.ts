/* eslint-disable curly */
import * as vscode from 'vscode';
import { FileInfo } from '../types/types';
import { FileInfoFactory } from '../utils/FileInfoFactory';
import { FileUtils } from '../utils/FileUtils';
import { PathResolver } from '../utils/PathResolver';
import { JavaScriptParser } from './JavaScriptParser';
import { ParserBase } from './ParserBase';

export class HtmlParser extends ParserBase {
    private pathResolver: PathResolver;
    private jsParser: JavaScriptParser;

    constructor(pathResolver: PathResolver) {
        super();
        this.pathResolver = pathResolver;
        this.jsParser = new JavaScriptParser();
    }

    public async parseHtmlFile(document: vscode.TextDocument): Promise<{ fileInfo: FileInfo, associatedJsFiles: string[] }> {
        const filePath = document.uri.fsPath;
        if (this.isFileBeingParsed(filePath)) {
            FileUtils.logDebugForAssociations(`跳过正在解析的HTML文件: ${filePath}`);
            return { fileInfo: FileInfoFactory.createEmpty(filePath), associatedJsFiles: [] };
        }

        this.markFileAsParsing(filePath);
        try {
            const fileInfo = FileInfoFactory.createEmpty(filePath);
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
            this.markFileAsFinishedParsing(filePath);
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

    private parseAngularExpressions(document: vscode.TextDocument, content: string, fileInfo: FileInfo): void {
        // 解析 {{expression}} 中的表达式
        const expressionRegex = /{{(.+?)}}/g;
        let match;
        while ((match = expressionRegex.exec(content)) !== null) {
            const expression = match[1];
            const startIndex = match.index + 2;  // +2 to skip {{
            this.extractFunctionReferences(document, expression, fileInfo, startIndex);
            this.extractScopeReferences(document, expression, fileInfo, startIndex);
            this.extractFilterReferences(document, expression, fileInfo, startIndex);
        }

        // 解析 ng-bind 和 ng-bind-html 属性中的表达式
        const ngBindRegex = /ng-bind(?:-html)?\s*=\s*["']([^"']+)["']/g;
        while ((match = ngBindRegex.exec(content)) !== null) {
            const expression = match[1];
            const startIndex = match.index + match[0].indexOf(expression);
            this.extractFunctionReferences(document, expression, fileInfo, startIndex);
            this.extractScopeReferences(document, expression, fileInfo, startIndex);
            this.extractFilterReferences(document, expression, fileInfo, startIndex);
        }

        // 解析所有 ng-* 指令中的表达式
        const directiveRegex = /ng-(if|show|hide|repeat|model|class|style)\s*=\s*["']((?:\{.+?\})|(?:.+?))["']/g;
        while ((match = directiveRegex.exec(content)) !== null) {
            const directive = match[1];
            const expression = match[2];
            const startIndex = match.index + match[0].indexOf(expression);
            
            // 如果是对象语法（以 { 开头），去掉外层的花括号
            if (expression.startsWith('{') && expression.endsWith('}')) {
                const innerExpression = expression.slice(1, -1);
                this.extractFunctionReferences(document, innerExpression, fileInfo, startIndex + 1);
                this.extractScopeReferences(document, innerExpression, fileInfo, startIndex + 1);
            } else {
                this.extractFunctionReferences(document, expression, fileInfo, startIndex);
                this.extractScopeReferences(document, expression, fileInfo, startIndex);
            }
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

    private extractScopeReferences(document: vscode.TextDocument, expression: string, fileInfo: FileInfo, startIndex: number): void {
        // 匹配简单的 scope 变量引用，如 act, rootPath 等
        const simpleVarRegex = /\b([a-zA-Z_$][a-zA-Z0-9_$]*)\b(?!\s*\()/g;  // 排除函数调用
        let varMatch;
        while ((varMatch = simpleVarRegex.exec(expression)) !== null) {
            const varName = varMatch[1];
            if (!this.shouldIgnoreReference(varName)) {
                const position = document.offsetAt(document.positionAt(startIndex + varMatch.index));
                this.addScopeVariableToFileInfo(fileInfo, varName, position, false);
            }
        }

        // 匹配属性访问表达式，如 act.ext_catgory, act.title 等
        const propertyAccessRegex = /([a-zA-Z_$][a-zA-Z0-9_$]*(?:\.[a-zA-Z_$][a-zA-Z0-9_$]*)+)(?!\s*\()/g;  // 排除函数调用
        let propMatch;
        while ((propMatch = propertyAccessRegex.exec(expression)) !== null) {
            const fullPath = propMatch[1];
            const parts = fullPath.split('.');
            
            // 添加根变量引用（如 act）
            const rootVar = parts[0];
            if (!this.shouldIgnoreReference(rootVar)) {
                const rootPosition = document.offsetAt(document.positionAt(startIndex + propMatch.index));
                this.addScopeVariableToFileInfo(fileInfo, rootVar, rootPosition, false);
            }

            // 为每个属性路径添加引用（如 act.ext_catgory）
            for (let i = 1; i < parts.length; i++) {
                const partialPath = parts.slice(0, i + 1).join('.');
                if (!this.shouldIgnoreReference(partialPath)) {
                    const partPosition = document.offsetAt(document.positionAt(
                        startIndex + propMatch.index + fullPath.indexOf(partialPath)
                    ));
                    this.addScopeVariableToFileInfo(fileInfo, partialPath, partPosition, false);
                }
            }
        }
    }

    private addScopeVariableToFileInfo(fileInfo: FileInfo, name: string, position: number, isDefinition: boolean) {
        // 添加到 scopeVariables
        if (!fileInfo.scopeVariables.has(name)) {
            fileInfo.scopeVariables.set(name, {
                name,
                position,
                type: 'variable',
                isDefinition
            });
        }

        // 同时添加到 functions 用于引用查找
        if (!fileInfo.functions.has(name)) {
            fileInfo.functions.set(name, []);
        }
        fileInfo.functions.get(name)!.push({
            name,
            position,
            type: 'variable',
            isDefinition
        });

        FileUtils.logDebugForFindDefinitionAndReference(
            `在HTML中找到scope变量引用: ${name}, 位置: ${position}`
        );
    }
}
