import * as vscode from 'vscode';
import { AngularParser } from './angularParser';
import { FileInfo, SUPPORTED_LANGUAGES } from './types/types';
import { FileUtils } from './utils/FileUtils';

export class ReferenceProvider implements vscode.ReferenceProvider {
    constructor(private angularParser: AngularParser) {}

    public async provideReferences(
        document: vscode.TextDocument,
        position: vscode.Position,
    ): Promise<vscode.Location[]> {
        const wordRange = document.getWordRangeAtPosition(position);
        if (!wordRange) {
            return [];
        }

        const word = document.getText(wordRange);
        FileUtils.logDebugForFindDefinitionAndReference(`正在查找引用: ${word}, 文件: ${document.fileName}, 位置: ${position.line+1}:${position.character+1}`);

        const references = new Map<string, vscode.Location>();

        // 在当前文件中查找引用
        const currentFileInfo = this.angularParser.getFileInfo(document.uri.fsPath);
        if (currentFileInfo) {
            this.findReferencesInFileInfo(currentFileInfo, document.uri, word, references);
        } else {
            FileUtils.log(`当前文件未解析: ${document.fileName}`);
            try {
                await this.angularParser.parseFile(document.uri);
                const updatedFileInfo = this.angularParser.getFileInfo(document.uri.fsPath);
                if (updatedFileInfo) {
                    this.findReferencesInFileInfo(updatedFileInfo, document.uri, word, references);
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

        // 创建临时 Map 数组来存储每个文件的引用结果
        const tempReferenceMaps = await Promise.all(
            associatedFiles.map(async (associatedFile) => {
                const tempReferences = new Map<string, vscode.Location>();
                const fileInfo = this.angularParser.getFileInfo(associatedFile);
                
                if (fileInfo) {
                    this.findReferencesInFileInfo(fileInfo, vscode.Uri.file(associatedFile), word, tempReferences);
                } else {
                    try {
                        await this.angularParser.parseFile(vscode.Uri.file(associatedFile));
                        const updatedFileInfo = this.angularParser.getFileInfo(associatedFile);
                        if (updatedFileInfo) {
                            this.findReferencesInFileInfo(updatedFileInfo, vscode.Uri.file(associatedFile), word, tempReferences);
                        }
                    } catch (error) {
                        const fileType = document.languageId === SUPPORTED_LANGUAGES.JAVASCRIPT ? 'HTML' : 'JS';
                        FileUtils.logError(`立即解析关联${fileType}文件失败: ${associatedFile}`, error);
                    }
                }
                return tempReferences;
            })
        );

        // 合并所有临时 Map 的结果到主 references Map
        for (const tempMap of tempReferenceMaps) {
            for (const [key, value] of tempMap) {
                references.set(key, value);
            }
        }

        const uniqueReferences = Array.from(references.values());
        FileUtils.logDebugForFindDefinitionAndReference(`找到 ${word} 的引用数量: ${uniqueReferences.length}`);
        return uniqueReferences;
    }

    private findReferencesInFileInfo(
        fileInfo: FileInfo, 
        uri: vscode.Uri,
        word: string, 
        references: Map<string, vscode.Location>
    ): void {
        const functionRefs = fileInfo.functions.get(word);
        if (functionRefs) {
            for (const ref of functionRefs) {
                if (!ref.isDefinition) {  // 只添加非定义的引用
                    const refPosition = this.angularParser.getPositionLocation(fileInfo.filePath, ref.position);
                    const range = new vscode.Range(refPosition, refPosition.translate(0, word.length));
                    const key = `${uri.fsPath}:${refPosition.line}:${refPosition.character}`;
                    if (!references.has(key)) {
                        references.set(key, new vscode.Location(uri, range));
                        FileUtils.logDebugForFindDefinitionAndReference(`找到 ${word} 的引用，位置: ${uri.fsPath}, 行 ${refPosition.line + 1}, 列 ${refPosition.character + 1}`);
                    }
                }
            }
        }
    }
}
