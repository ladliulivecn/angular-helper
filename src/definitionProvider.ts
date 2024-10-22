/* eslint-disable curly */
import * as vscode from 'vscode';
import { AngularParser } from './angularParser';
import { FileUtils } from './utils/FileUtils';

export class DefinitionProvider implements vscode.DefinitionProvider {
    constructor(private angularParser: AngularParser) {}

    public async provideDefinition(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken
    ): Promise<vscode.Location | vscode.Location[] | vscode.LocationLink[] | undefined> {
        const wordRange = document.getWordRangeAtPosition(position);
        if (!wordRange) {
            FileUtils.logDebugForFindDefinitionAndReference(`未找到单词范围，位置: ${position.line+1}:${position.character+1}`);
            return undefined;
        }

        const word = document.getText(wordRange);
        FileUtils.logDebugForFindDefinitionAndReference(`正在查找定义: ${word}, 文件: ${document.fileName}, 位置: ${position.line+1}:${position.character+1}`);

        const fileInfo = this.angularParser.getFileInfo(document.uri.fsPath);
        if (!fileInfo) {
            return undefined;
        }

        // 检查是否是函数定义
        const functionInfo = fileInfo.functions.get(word);
        if (functionInfo && functionInfo.length > 0) {
            const definition = functionInfo.find(f => f.isDefinition);
            if (definition) {
                const definitionPosition = this.angularParser.getPositionLocation(document.uri.fsPath, definition.position);
                FileUtils.logDebugForFindDefinitionAndReference(`找到函数 ${word} 的定义，位置: ${document.uri.fsPath}, 行 ${definitionPosition.line + 1}, 列 ${definitionPosition.character + 1}`);
                return new vscode.Location(
                    document.uri,
                    definitionPosition
                );
            }
        }

        // 检查是否是 $scope 变量
        const scopeVariable = fileInfo.scopeVariables.get(word);
        if (scopeVariable) {
            const variablePosition = this.angularParser.getPositionLocation(document.uri.fsPath, scopeVariable.position);
            FileUtils.logDebugForFindDefinitionAndReference(`找到 $scope 变量 ${word} 的定义，位置: ${document.uri.fsPath}, 行 ${variablePosition.line + 1}, 列 ${variablePosition.character + 1}`);
            return new vscode.Location(
                document.uri,
                variablePosition
            );
        }

        // 如果在当前文件中没有找到定义，尝试在关联的文件中查找
        const associatedFiles = this.angularParser.getAssociatedJsFiles(document.uri.fsPath);
        for (const associatedFile of associatedFiles) {
            const associatedFileInfo = this.angularParser.getFileInfo(associatedFile);
            if (associatedFileInfo) {
                const associatedFunctionInfo = associatedFileInfo.functions.get(word);
                if (associatedFunctionInfo && associatedFunctionInfo.length > 0) {
                    const definition = associatedFunctionInfo.find(f => f.isDefinition);
                    if (definition) {
                        const definitionPosition = this.angularParser.getPositionLocation(associatedFile, definition.position);
                        FileUtils.logDebugForFindDefinitionAndReference(`在关联文件中找到函数 ${word} 的定义，位置: ${associatedFile}, 行 ${definitionPosition.line + 1}, 列 ${definitionPosition.character + 1}`);
                        return new vscode.Location(
                            vscode.Uri.file(associatedFile),
                            definitionPosition
                        );
                    }
                }

                const associatedScopeVariable = associatedFileInfo.scopeVariables.get(word);
                if (associatedScopeVariable) {
                    const variablePosition = this.angularParser.getPositionLocation(associatedFile, associatedScopeVariable.position);
                    FileUtils.logDebugForFindDefinitionAndReference(`在关联文件中找到 $scope 变量 ${word} 的定义，位置: ${associatedFile}, 行 ${variablePosition.line + 1}, 列 ${variablePosition.character + 1}`);
                    return new vscode.Location(
                        vscode.Uri.file(associatedFile),
                        variablePosition
                    );
                }
            }
        }

        FileUtils.logDebugForFindDefinitionAndReference(`未找到 ${word} 的定义`);
        return undefined;
    }
}
