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
        FileUtils.logDebugForFindDefinitionAndReference(
            `开始解析内联JavaScript, 文件: ${document.fileName}`
        );

        const scriptRegex = /<script(?![^>]*src=)([^>]*)>([\s\S]*?)<\/script>/g;
        let match;
        let matchCount = 0;

        while ((match = scriptRegex.exec(content)) !== null) {
            matchCount++;
            const attributes = match[1] || '';
            const scriptContent = match[2];
            const startPosition = match.index + match[0].indexOf(scriptContent);
            
            FileUtils.logDebugForFindDefinitionAndReference(
                `找到第 ${matchCount} 个script标签:` +
                `\n位置: ${startPosition}` +
                `\n属性: ${attributes}` +
                `\n内容长度: ${scriptContent.length}` +
                `\n内容前100个字符: ${scriptContent.substring(0, 100)}...` +
                `\n内容后100个字符: ...${scriptContent.substring(scriptContent.length - 100)}`
            );

            // 检查 script 标签的类型
            const typeMatch = attributes.match(/type=["']([^"']+)["']/);
            const scriptType = typeMatch ? typeMatch[1].toLowerCase() : 'text/javascript';
            
            // 修改判断逻辑：如果没有type属性或者是JavaScript类型，就处理该脚本
            if (!typeMatch || scriptType.includes('javascript') || scriptType === 'application/javascript') {
                if (!scriptContent.trim()) {
                    FileUtils.logDebugForFindDefinitionAndReference(
                        `跳过空的脚本内容`
                    );
                    continue;
                }

                try {
                    FileUtils.logDebugForFindDefinitionAndReference(
                        `开始解析脚本内容, 类型: ${scriptType}, 起始位置: ${startPosition}`
                    );
                    this.jsParser.parseJavaScriptContent(scriptContent, fileInfo, document);
                } catch (error) {
                    FileUtils.logDebugForFindDefinitionAndReference(
                        `解析内联脚本时发生错误: ${error}`
                    );
                }
            } else {
                FileUtils.logDebugForFindDefinitionAndReference(
                    `跳过非JavaScript类型的脚本: ${scriptType}`
                );
            }
        }

        if (matchCount === 0) {
            FileUtils.logDebugForFindDefinitionAndReference(
                `未找到任何内联脚本标签`
            );
        } else {
            FileUtils.logDebugForFindDefinitionAndReference(
                `共找到 ${matchCount} 个script标签`
            );
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
        // 用于跟踪已处理的变量引用，避免重复
        const processedReferences = new Set<string>();

        // 修改正则表达式以避免重复匹配
        // 1. 匹配完整的属性访问表达式
        const propertyAccessRegex = /\b([a-zA-Z_$][a-zA-Z0-9_$]*(?:\.[a-zA-Z_$][a-zA-Z0-9_$]*)*)\b(?!\s*\()/g;
        let propMatch;
        while ((propMatch = propertyAccessRegex.exec(expression)) !== null) {
            const fullPath = propMatch[1];
            const parts = fullPath.split('.');
            
            // 处理每个部分
            let currentPath = '';
            for (let i = 0; i < parts.length; i++) {
                if (i === 0) {
                    currentPath = parts[i];
                } else {
                    currentPath += '.' + parts[i];
                }
                
                const position = document.offsetAt(document.positionAt(
                    startIndex + propMatch.index + fullPath.indexOf(currentPath)
                ));
                const referenceKey = `${currentPath}:${position}`;
                
                if (!this.shouldIgnoreReference(currentPath) && !processedReferences.has(referenceKey)) {
                    processedReferences.add(referenceKey);
                    this.addScopeVariableToFileInfo(fileInfo, currentPath, position, false);
                }
            }
        }

        // 2. 匹配单独的标识符（不包含在属性访问表达式中的）
        const simpleVarRegex = /\b([a-zA-Z_$][a-zA-Z0-9_$]*)\b(?!\s*[\(.])/g;
        let varMatch;
        while ((varMatch = simpleVarRegex.exec(expression)) !== null) {
            const varName = varMatch[1];
            const position = document.offsetAt(document.positionAt(startIndex + varMatch.index));
            const referenceKey = `${varName}:${position}`;
            
            if (!this.shouldIgnoreReference(varName) && !processedReferences.has(referenceKey)) {
                processedReferences.add(referenceKey);
                this.addScopeVariableToFileInfo(fileInfo, varName, position, false);
            }
        }
    }

    private addScopeVariableToFileInfo(fileInfo: FileInfo, name: string, position: number, isDefinition: boolean) {
        // 使用位置信息创建唯一标识
        const referenceKey = `${name}:${position}`;
        
        // 检查是否已经添加过这个位置的引用
        if (fileInfo.functions.has(name)) {
            const existingRefs = fileInfo.functions.get(name)!;
            // 检查是否已存在相同位置的引用
            if (existingRefs.some(ref => ref.position === position)) {
                return; // 如果已存在相同位置的引用，直接返回
            }
        }

        // 添加到 scopeVariables
        if (!fileInfo.scopeVariables.has(name)) {
            fileInfo.scopeVariables.set(name, {
                name,
                position,
                type: 'variable',
                isDefinition
            });
        } else if (isDefinition) {
            // 如果是定义且位置更早，则更新
            const existing = fileInfo.scopeVariables.get(name)!;
            if (position < existing.position) {
                fileInfo.scopeVariables.set(name, {
                    name,
                    position,
                    type: 'variable',
                    isDefinition: true
                });
            }
        }

        // 添加到 functions 集合中用于引用查找
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
            `添加变量${isDefinition ? '定义' : '引用'}: ${name}, 位置: ${position}`
        );
    }
}
