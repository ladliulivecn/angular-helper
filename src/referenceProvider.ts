import * as vscode from 'vscode';
import { AngularParser } from './angularParser';
import { SUPPORTED_LANGUAGES, FileInfo } from './types/types';
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
        }

        // 在关联的文件中查找引用
        if (document.languageId === SUPPORTED_LANGUAGES.JAVASCRIPT) {
            const htmlFiles = this.angularParser.getAssociatedHtmlFiles(document.uri.fsPath);
            for (const htmlFile of htmlFiles) {
                const fileInfo = this.angularParser.getFileInfo(htmlFile);
                if (fileInfo) {
                    this.findReferencesInFileInfo(fileInfo, vscode.Uri.file(htmlFile), word, references);
                } else {
                    FileUtils.logDebugForFindDefinitionAndReference(`关联的HTML文件未解析: ${htmlFile}`);
                }
            }
        } else if (document.languageId === SUPPORTED_LANGUAGES.HTML) {
            const jsFiles = this.angularParser.getAssociatedJsFiles(document.uri.fsPath);
            for (const jsFile of jsFiles) {
                const fileInfo = this.angularParser.getFileInfo(jsFile);
                if (fileInfo) {
                    this.findReferencesInFileInfo(fileInfo, vscode.Uri.file(jsFile), word, references);
                } else {
                    FileUtils.logDebugForFindDefinitionAndReference(`关联的JS文件未解析: ${jsFile}`);
                }
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
