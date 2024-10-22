import * as vscode from 'vscode';
import { FileInfo } from '../types/types';
import { FileUtils } from '../utils/FileUtils';
import { PathResolver } from '../utils/PathResolver';
import { JavaScriptParser } from './JavaScriptParser';

export class HtmlParser {
    private config !: vscode.WorkspaceConfiguration;
    private pathResolver: PathResolver;
    private jsParser: JavaScriptParser;

    constructor(config: vscode.WorkspaceConfiguration, pathResolver: PathResolver) {
        this.updateConfiguration(config);
        this.pathResolver = pathResolver;
        this.jsParser = new JavaScriptParser();
    }

    public updateConfiguration(config: vscode.WorkspaceConfiguration): void {
        this.config = config;
    }

    public async parseHtmlFile(document: vscode.TextDocument): Promise<{ fileInfo: FileInfo, associatedJsFiles: string[] }> {
        FileUtils.logDebugForAssociations(`开始解析HTML文件: ${document.uri.fsPath}`);
        const fileInfo: FileInfo = this.createEmptyFileInfo(document);
        const content = document.getText();

        // 首先解析关联的JS文件
        const associatedJsFiles = await this.parseHtmlForJsFiles(document);
        FileUtils.logDebugForAssociations(`HTML文件 ${document.uri.fsPath} 关联的JS文件: ${associatedJsFiles.join(', ')}`);

        // 然后解析HTML内容
        this.parseNgAttributes(document, content, fileInfo);
        this.parseInlineJavaScript(document, content, fileInfo);

        return { fileInfo, associatedJsFiles };
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
            
            if (['click', 'change', 'submit', 'keyup', 'keydown', 'mouseover', 'mouseout'].includes(directive)) {
                this.extractFunctionReferences(document, value, fileInfo, match.index + match[0].indexOf(value));
            }
            
            fileInfo.ngAttributes.set(directive, {
                name: directive,
                position: document.offsetAt(document.positionAt(match.index)),
                type: 'ngAttribute',
                value: value,
                isDefinition: false
            });
        }
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

    private extractFunctionReferences(document: vscode.TextDocument, value: string, fileInfo: FileInfo, startIndex: number): void {
        const functionNameRegex = /\b(\w+)\s*\(/g;
        let functionMatch;
        while ((functionMatch = functionNameRegex.exec(value)) !== null) {
            const functionName = functionMatch[1];
            const position = document.offsetAt(document.positionAt(startIndex + functionMatch.index));
            this.addFunctionToFileInfo(fileInfo, functionName, position, false);
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
}
