/* eslint-disable curly */
import * as vscode from 'vscode';
import { AngularParser } from './angularParser';
import { FileInfo, SUPPORTED_LANGUAGES } from './types/types';
import { FileUtils } from './utils/FileUtils';

export class DefinitionProvider implements vscode.DefinitionProvider {
    constructor(private angularParser: AngularParser) {}

    public async provideDefinition(
        document: vscode.TextDocument,
        position: vscode.Position,        
    ): Promise<vscode.Location | vscode.Location[] | vscode.LocationLink[] | undefined> {
        const propertyChain = this.getPropertyChainAtPosition(document, position);
        if (!propertyChain) {
            return undefined;
        }

        const word = propertyChain;
        FileUtils.logDebugForFindDefinitionAndReference(
            `正在查找定义或引用: ${word}, 文件: ${document.fileName}, ` + 
            `位置: ${position.line+1}:${position.character+1}`
        );

        const locations: vscode.Location[] = [];
        const definitions: vscode.Location[] = [];

        // 在当前文件中查找定义和引用
        const currentFileInfo = this.angularParser.getFileInfo(document.uri.fsPath);
        if (currentFileInfo) {
            this.findLocationsInFileInfo(currentFileInfo, document.uri, word, locations, definitions);
        } else {
            FileUtils.log(`当前文件未解析: ${document.fileName}`);
        }

        // 在关联文件中查找定义和引用
        if (document.languageId === SUPPORTED_LANGUAGES.JAVASCRIPT) {
            const htmlFiles = this.angularParser.getAssociatedHtmlFiles(document.uri.fsPath);
            for (const htmlFile of htmlFiles) {
                const fileInfo = this.angularParser.getFileInfo(htmlFile);
                if (fileInfo) {
                    this.findLocationsInFileInfo(fileInfo, vscode.Uri.file(htmlFile), word, locations, definitions);
                } else {
                    FileUtils.logDebugForFindDefinitionAndReference(`关联的HTML文件未解析: ${htmlFile}`);
                }
            }
        } else if (document.languageId === SUPPORTED_LANGUAGES.HTML) {
            const jsFiles = this.angularParser.getAssociatedJsFiles(document.uri.fsPath);
            for (const jsFile of jsFiles) {
                const fileInfo = this.angularParser.getFileInfo(jsFile);
                if (fileInfo) {
                    this.findLocationsInFileInfo(fileInfo, vscode.Uri.file(jsFile), word, locations, definitions);
                } else {
                    FileUtils.logDebugForFindDefinitionAndReference(`关联的JS文件未解析: ${jsFile}`);
                }
            }
        }

        // 如果在 HTML 文件中，优先跳转到定义
        if (document.languageId === SUPPORTED_LANGUAGES.HTML && definitions.length > 0) {
            return definitions[0];
        }

        // 返回所有位置（包括定义和引用）
        const allLocations = [...definitions, ...locations];
        if (allLocations.length > 0) {
            return allLocations;
        }

        return undefined;
    }

    private findLocationsInFileInfo(
        fileInfo: FileInfo, 
        uri: vscode.Uri,
        word: string, 
        locations: vscode.Location[],
        definitions: vscode.Location[]
    ): void {
        const functionRefs = fileInfo.functions.get(word);
        if (functionRefs) {
            for (const ref of functionRefs) {
                const refPosition = this.angularParser.getPositionLocation(fileInfo.filePath, ref.position);
                const range = new vscode.Range(refPosition, refPosition.translate(0, word.length));
                const location = new vscode.Location(uri, range);

                if (ref.isDefinition) {
                    definitions.push(location);
                    FileUtils.logDebugForFindDefinitionAndReference(`找到 ${word} 的定义，位置: ${uri.fsPath}, 行 ${refPosition.line + 1}, 列 ${refPosition.character + 1}`);
                } else {
                    locations.push(location);
                    FileUtils.logDebugForFindDefinitionAndReference(`找到 ${word} 的引用，位置: ${uri.fsPath}, 行 ${refPosition.line + 1}, 列 ${refPosition.character + 1}`);
                }
            }
        }
    }

    private getPropertyChainAtPosition(document: vscode.TextDocument, position: vscode.Position): string | undefined {
        const line = document.lineAt(position.line).text;
        const wordRange = document.getWordRangeAtPosition(position, /[a-zA-Z0-9_$]+/);
        if (!wordRange) {
            return undefined;
        }

        // 获取光标所在的单词
        const word = document.getText(wordRange);

        // 向前查找属性链的开始
        const beforeCursor = line.slice(0, wordRange.start.character);
        let propertyStart = wordRange.start.character;
        
        for (let i = beforeCursor.length - 1; i >= 0; i--) {
            const char = beforeCursor[i];
            if (char === ' ' || char === '"' || char === "'") break;
            if (/[a-zA-Z0-9_$.]/.test(char)) {
                propertyStart = i;
            } else {
                break;
            }
        }

        // 获取完整的属性链
        const propertyChain = line.slice(propertyStart, wordRange.end.character);
        if (/^[a-zA-Z_$][a-zA-Z0-9_$.]*$/.test(propertyChain)) {
            // 如果属性链以 $scope. 开头，则去掉这个前缀
            if (propertyChain.startsWith('$scope.')) {
                return propertyChain.substring(7);  // 7 是 '$scope.' 的长度
            }
            return propertyChain;
        }

        return word;
    }
}
