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
            try {
                await this.angularParser.parseFile(document.uri);
                const updatedFileInfo = this.angularParser.getFileInfo(document.uri.fsPath);
                if (updatedFileInfo) {
                    this.findLocationsInFileInfo(updatedFileInfo, document.uri, word, locations, definitions);
                }
            } catch (error) {
                FileUtils.logError(`立即解析文件失败: ${document.fileName}`, error);
            }
        }

        // 并行处理关联文件
        const associatedFiles = document.languageId === SUPPORTED_LANGUAGES.JAVASCRIPT 
            ? this.angularParser.getAssociatedHtmlFiles(document.uri.fsPath)
            : document.languageId === SUPPORTED_LANGUAGES.HTML 
                ? this.angularParser.getAssociatedJsFiles(document.uri.fsPath)
                : [];

        // 创建临时数组来存储每个文件的位置结果
        const tempResults = await Promise.all(
            associatedFiles.map(async (associatedFile) => {
                const tempLocations: vscode.Location[] = [];
                const tempDefinitions: vscode.Location[] = [];
                const fileInfo = this.angularParser.getFileInfo(associatedFile);
                
                if (fileInfo) {
                    this.findLocationsInFileInfo(fileInfo, vscode.Uri.file(associatedFile), word, tempLocations, tempDefinitions);
                } else {
                    try {
                        await this.angularParser.parseFile(vscode.Uri.file(associatedFile));
                        const updatedFileInfo = this.angularParser.getFileInfo(associatedFile);
                        if (updatedFileInfo) {
                            this.findLocationsInFileInfo(updatedFileInfo, vscode.Uri.file(associatedFile), word, tempLocations, tempDefinitions);
                        }
                    } catch (error) {
                        const fileType = document.languageId === SUPPORTED_LANGUAGES.JAVASCRIPT ? 'HTML' : 'JS';
                        FileUtils.logError(`立即解析关联${fileType}文件失败: ${associatedFile}`, error);
                    }
                }
                return { tempLocations, tempDefinitions };
            })
        );

        // 合并所有临时结果
        for (const result of tempResults) {
            locations.push(...result.tempLocations);
            definitions.push(...result.tempDefinitions);
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
        try {
            const line = document.lineAt(position.line).text;
            const wordRange = document.getWordRangeAtPosition(position, /[a-zA-Z0-9_$]+/);
            if (!wordRange || wordRange.isEmpty) {
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
        } catch (error) {
            FileUtils.logError('获取属性链时出错:', error);
            return undefined;
        }
    }
}
