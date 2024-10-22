import * as vscode from 'vscode';
import { AngularParser } from './angularParser';
import { FileUtils } from './utils/FileUtils';
import { SUPPORTED_LANGUAGES } from './types/types';

export class ReferenceProvider implements vscode.ReferenceProvider {
    constructor(private angularParser: AngularParser) {}

    public provideReferences(
        document: vscode.TextDocument,
        position: vscode.Position,
        context: vscode.ReferenceContext,
        token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.Location[]> {
        const wordRange = document.getWordRangeAtPosition(position);
        if (!wordRange) {
            return undefined;
        }

        const word = document.getText(wordRange);
        FileUtils.logDebugForFindDefinitionAndReference(`正在查找引用: ${word}, 文件: ${document.fileName}, 位置: ${position.line+1}:${position.character+1}`);

        const references = new Map<string, vscode.Location>();

        // 在当前文件中查找引用
        this.findReferencesInFile(document, word, references);

        // 在关联的文件中查找引用
        if (document.languageId === SUPPORTED_LANGUAGES.JAVASCRIPT) {
            const associatedHtmlFiles = this.angularParser.getAssociatedHtmlFiles(document.uri.fsPath);
            for (const htmlFile of associatedHtmlFiles) {
                const htmlDocument = vscode.workspace.textDocuments.find(doc => doc.uri.fsPath === htmlFile);
                if (htmlDocument) {
                    this.findReferencesInFile(htmlDocument, word, references);
                }
            }
        } else if (document.languageId === SUPPORTED_LANGUAGES.HTML) {
            const associatedJsFiles = this.angularParser.getAssociatedJsFiles(document.uri.fsPath);
            for (const jsFile of associatedJsFiles) {
                const jsDocument = vscode.workspace.textDocuments.find(doc => doc.uri.fsPath === jsFile);
                if (jsDocument) {
                    this.findReferencesInFile(jsDocument, word, references);
                }
            }
        }

        const uniqueReferences = Array.from(references.values());
        FileUtils.logDebugForFindDefinitionAndReference(`找到 ${word} 的引用数量: ${uniqueReferences.length}`);
        return uniqueReferences;
    }

    private findReferencesInFile(document: vscode.TextDocument, word: string, references: Map<string, vscode.Location>): void {
        const fileInfo = this.angularParser.getFileInfo(document.uri.fsPath);
        if (!fileInfo) {
            return;
        }

        const functionReferences = fileInfo.functions.get(word);
        if (functionReferences) {
            for (const ref of functionReferences) {
                if (!ref.isDefinition) {  // 只添加非定义的引用
                    const refPosition = this.angularParser.getPositionLocation(document.uri.fsPath, ref.position);
                    const key = `${document.uri.fsPath}:${refPosition.line}:${refPosition.character}`;
                    if (!references.has(key)) {
                        references.set(key, new vscode.Location(document.uri, refPosition));
                        FileUtils.logDebugForFindDefinitionAndReference(`找到 ${word} 的引用，位置: ${document.uri.fsPath}, 行 ${refPosition.line + 1}, 列 ${refPosition.character + 1}`);
                    }
                }
            }
        }

        // 检查 HTML 文件中的 ng-* 属性
        if (document.languageId === SUPPORTED_LANGUAGES.HTML) {
            const content = document.getText();
            const ngAttributeRegex = new RegExp(`ng-\\w+\\s*=\\s*["'].*?${word}\\s*\\(.*?["']`, 'g');
            let match;
            while ((match = ngAttributeRegex.exec(content)) !== null) {
                const functionCallIndex = match[0].indexOf(word);
                if (functionCallIndex !== -1) {
                    const functionCallPosition = document.positionAt(match.index + functionCallIndex);
                    const key = `${document.uri.fsPath}:${functionCallPosition.line}:${functionCallPosition.character}`;
                    if (!references.has(key)) {
                        references.set(key, new vscode.Location(
                            document.uri,
                            new vscode.Range(functionCallPosition, functionCallPosition.translate(0, word.length))
                        ));
                        FileUtils.logDebugForFindDefinitionAndReference(`找到 ${word} 的 ng-* 属性引用，位置: ${document.uri.fsPath}, 行 ${functionCallPosition.line + 1}, 列 ${functionCallPosition.character + 1}`);
                    }
                }
            }
        }
    }
}
