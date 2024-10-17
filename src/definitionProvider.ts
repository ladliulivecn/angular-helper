/* eslint-disable curly */
import * as vscode from 'vscode';
import { AngularParser, FileInfo } from './angularParser';
import { log } from './extension';

export class DefinitionProvider implements vscode.DefinitionProvider, vscode.ReferenceProvider {
    private performanceLog: { [key: string]: number[] } = {};
    private enablePerformanceLogging: boolean;

    constructor(private angularParser: AngularParser) {
        const config = vscode.workspace.getConfiguration('angularHelper');
        this.enablePerformanceLogging = config.get<boolean>('enablePerformanceLogging', false);
    }

    public provideDefinition(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.Definition | vscode.LocationLink[]> {
        const startTime = performance.now();
        
        const wordRange = document.getWordRangeAtPosition(position);
        if (!wordRange) {
            return null;
        }

        const word = document.getText(wordRange);
        log(`正在查找定义: ${word}`);

        // 首先在当前文件中查找定义
        const currentFileInfo = this.angularParser.getFileInfo(document.fileName);
        if (currentFileInfo) {
            const definition = this.findDefinitionInFileInfo(currentFileInfo, word, document.uri);
            if (definition) {
                this.logPerformance('definitionLookup', startTime);
                return definition;
            }
        }

        // 如果在当前文件中没有找到，尝试在关联的文件中查找
        if (document.languageId === 'html') {
            return this.findDefinitionInAssociatedJsFiles(word, document).then(result => {
                this.logPerformance('definitionLookup', startTime);
                return result;
            });
        } else if (document.languageId === 'javascript') {
            return this.findDefinitionInAssociatedHtmlFiles(word, document).then(result => {
                this.logPerformance('definitionLookup', startTime);
                return result;
            });
        }

        this.logPerformance('definitionLookup', startTime);
        return null;
    }

    private findDefinitionInFileInfo(fileInfo: FileInfo, word: string, uri: vscode.Uri): vscode.Location | null {
        const definitionTypes: (keyof FileInfo)[] = ['controllers', 'services', 'directives', 'functions', 'scopeVariables', 'components'];
        for (const type of definitionTypes) {
            const definitions = fileInfo[type];
            if (definitions instanceof Map) {
                const definition = definitions.get(word);
                if (definition) {
                    log(`在 ${uri.fsPath} 中找到 ${word} 的定义，类型: ${type}`);
                    const position = this.angularParser.getPositionLocation(uri.fsPath, definition.position);
                    return new vscode.Location(uri, position);
                }
            }
        }
        return null;
    }

    private async findDefinitionInAssociatedJsFiles(word: string, document: vscode.TextDocument): Promise<vscode.Location | null> {
        const associatedJsFiles = this.angularParser.getAssociatedJsFiles(document.fileName);
        for (const jsFile of associatedJsFiles) {
            const jsFileInfo = this.angularParser.getFileInfo(jsFile);
            if (jsFileInfo) {
                const definition = this.findDefinitionInFileInfo(jsFileInfo, word, vscode.Uri.file(jsFile));
                if (definition) {
                    return definition;
                }
            }
        }
        return null;
    }

    private async findDefinitionInAssociatedHtmlFiles(word: string, document: vscode.TextDocument): Promise<vscode.Location | null> {
        const associatedHtmlFiles = this.angularParser.getAssociatedHtmlFiles(document.fileName);
        for (const htmlFile of associatedHtmlFiles) {
            const htmlFileInfo = this.angularParser.getFileInfo(htmlFile);
            if (htmlFileInfo) {
                const definition = this.findDefinitionInFileInfo(htmlFileInfo, word, vscode.Uri.file(htmlFile));
                if (definition) {
                    return definition;
                }
            }
        }
        return null;
    }

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
            log(`${operation} 平均时间: ${average.toFixed(2)}ms (最近100次操作)`);
        }
    }

    public outputPerformanceReport() {
        if (!this.enablePerformanceLogging) {
            log('性能日志记录已禁用。');
            return;
        }

        log('性能报告:');
        for (const [operation, times] of Object.entries(this.performanceLog)) {
            const average = times.reduce((a, b) => a + b, 0) / times.length;
            log(`${operation}: 平均 ${average.toFixed(2)}ms, 次数: ${times.length}`);
        }
    }

    public provideReferences(
        document: vscode.TextDocument,
        position: vscode.Position,
        context: vscode.ReferenceContext,
        token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.Location[]> {
        const startTime = performance.now();

        const wordRange = document.getWordRangeAtPosition(position);
        if (!wordRange) {
            return null;
        }

        const word = document.getText(wordRange);
        log(`正在查找引用: ${word}`);

        const references: vscode.Location[] = [];

        // 在当前文件中查找引用
        this.findReferencesInFile(document, word, references);

        // 在关联文件中查找引用
        if (document.languageId === 'javascript') {
            this.findReferencesInAssociatedHtmlFiles(document.uri, word, references);
        } else if (document.languageId === 'html') {
            this.findReferencesInAssociatedJsFiles(document.uri, word, references);
        }

        this.logPerformance('referenceLookup', startTime);
        return references;
    }

    private findReferencesInFile(document: vscode.TextDocument, word: string, references: vscode.Location[]): void {
        const fileInfo = this.angularParser.getFileInfo(document.fileName);
        if (!fileInfo) return;

        this.addReferencesFromMap(fileInfo.functions, word, document.uri, references);
        this.addReferencesFromMap(fileInfo.scopeVariables, word, document.uri, references);
        // 可以根据需要添加其他类型的引用查找
    }

    private findReferencesInAssociatedHtmlFiles(jsUri: vscode.Uri, word: string, references: vscode.Location[]): void {
        const associatedHtmlFiles = this.angularParser.getAssociatedHtmlFiles(jsUri.fsPath);
        for (const htmlFile of associatedHtmlFiles) {
            const htmlFileInfo = this.angularParser.getFileInfo(htmlFile);
            if (htmlFileInfo) {
                this.addReferencesFromMap(htmlFileInfo.functions, word, vscode.Uri.file(htmlFile), references);
                // 可以根据需要添加其他类型的引用查找
            }
        }
    }

    private findReferencesInAssociatedJsFiles(htmlUri: vscode.Uri, word: string, references: vscode.Location[]): void {
        const associatedJsFiles = this.angularParser.getAssociatedJsFiles(htmlUri.fsPath);
        for (const jsFile of associatedJsFiles) {
            const jsFileInfo = this.angularParser.getFileInfo(jsFile);
            if (jsFileInfo) {
                this.addReferencesFromMap(jsFileInfo.functions, word, vscode.Uri.file(jsFile), references);
                this.addReferencesFromMap(jsFileInfo.scopeVariables, word, vscode.Uri.file(jsFile), references);
                // 可以根据需要添加其他类型的引用查找
            }
        }
    }

    private addReferencesFromMap(
        map: Map<string, { position: number }>,
        word: string,
        uri: vscode.Uri,
        references: vscode.Location[]
    ): void {
        const item = map.get(word);
        if (item) {
            const position = this.angularParser.getPositionLocation(uri.fsPath, item.position);
            references.push(new vscode.Location(uri, position));
        }
    }
}
