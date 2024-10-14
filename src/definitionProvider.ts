import * as vscode from 'vscode';
import { AngularDefinition, AngularParser, FileInfo } from './angularParser';

/**
 * DefinitionProvider 类实现了 vscode.DefinitionProvider 接口
 * 用于提供 Angular 定义的查找功能
 */
export class DefinitionProvider implements vscode.DefinitionProvider {
    /**
     * 创建 DefinitionProvider 的实例
     * @param {AngularParser} angularParser - Angular 解析器实例
     */
    constructor(private angularParser: AngularParser) {}

    /**
     * 提供定义位置
     * @param {vscode.TextDocument} document - 当前文档
     * @param {vscode.Position} position - 光标位置
     * @returns {Promise<vscode.Definition | vscode.LocationLink[] | null>} 定义位置或位置链接数组
     */
    async provideDefinition(
        document: vscode.TextDocument,
        position: vscode.Position,        
    ): Promise<vscode.Definition | vscode.LocationLink[] | null> {
        const wordRange = document.getWordRangeAtPosition(position);
        if (!wordRange) {
            return null;
        }
        const word = document.getText(wordRange);

        // 检查是否是 Angular 表达式
        if (this.isAngularExpression(document, position)) {
            return this.findAngularExpressionDefinitionInHtml(word, document);
        }

        if (document.languageId === 'html') {
            return this.findDefinitionInTypeScript(word, document);
        } else if (['typescript', 'javascript'].includes(document.languageId)) {
            return this.findDefinitionInHtml(word);
        }

        return null;
    }

    /**
     * 检查是否是 Angular 表达式
     * @param {vscode.TextDocument} document - 当前文档
     * @param {vscode.Position} position - 光标位置
     * @returns {boolean} 是否是 Angular 表达式
     */
    private isAngularExpression(document: vscode.TextDocument, position: vscode.Position): boolean {
        const lineText = document.lineAt(position.line).text;
        // 使用更精确的正则表达式
        return /ng-[a-zA-Z-]+="[^"]*\b\w+(?:\.\w+)+\b[^"]*"/.test(lineText) || 
               /{{[^}]*\b\w+(?:\.\w+)+\b[^}]*}}/.test(lineText);
    }

    /**
     * 在 HTML 中查找 Angular 表达式的定义
     * @param {string} property - 要查找的属性
     * @param {vscode.TextDocument} document - 当前文档
     * @returns {Promise<vscode.Location | null>} 定义位置
     */
    private async findAngularExpressionDefinitionInHtml(property: string, document: vscode.TextDocument): Promise<vscode.Location | null> {
        const content = document.getText();
        // 匹配 ng- 属性和 {{ }} 表达式
        const regex = new RegExp(`(ng-[a-zA-Z-]+="[^"]*${property}[^"]*")|({{[^}]*${property}[^}]*}})`, 'g');
        const matches = Array.from(content.matchAll(regex));

        for (const match of matches) {
            if (match.index !== undefined) {
                return new vscode.Location(
                    document.uri,
                    document.positionAt(match.index)
                );
            }
        }

        // 如果在当前文件中没找到，尝试在其他 JS 文件中查找
        const jsFiles = await vscode.workspace.findFiles('**/*.js');
        return this.searchInFiles(jsFiles, regex);
    }

    /**
     * 在文件中搜索定义
     * @param {vscode.Uri[]} files - 要搜索的文件 URI 数组
     * @param {RegExp} regex - 搜索用的正则表达式
     * @returns {Promise<vscode.Location | null>} 定义位置
     */
    private async searchInFiles(files: vscode.Uri[], regex: RegExp): Promise<vscode.Location | null> {
        for (const file of files) {
            try {
                const otherDocument = await vscode.workspace.openTextDocument(file);
                const otherContent = otherDocument.getText();
                const match = regex.exec(otherContent);
                if (match && match.index !== undefined) {
                    return new vscode.Location(file, otherDocument.positionAt(match.index));
                }
            } catch (error) {
                console.error(`Error opening ${file.fsPath}:`, error);
            }
        }
        return null;
    }

    /**
     * 在 TypeScript 文件中查找定义
     * @param {string} word - 要查找的单词
     * @param {vscode.TextDocument} document - 当前文档
     * @returns {vscode.Location | null} 定义位置
     */
    private findDefinitionInTypeScript(word: string, document: vscode.TextDocument): vscode.Location | null {
        // 遍历所有解析过的文件
        const allFiles = this.angularParser.getAllParsedFiles();
        for (const fileName of allFiles) {
            const fileInfo = this.angularParser.getFileInfo(fileName);
            if (fileInfo) {
                const definition = this.findDefinitionInFileInfo(fileInfo, word);
                if (definition) {
                    // 返回找到的定义位置
                    return new vscode.Location(
                        vscode.Uri.file(fileName),
                        new vscode.Position(definition.position, 0)
                    );
                }
            }
        }

        // 如果在 TypeScript 中没找到，尝试在当前 HTML 文件中查找
        return this.findDefinitionInCurrentHtml(word, document);
    }

    /**
     * 在文件信息中查找定义
     * @param {FileInfo} fileInfo - 文件信息
     * @param {string} word - 要查找的单词
     * @returns {AngularDefinition | null} 找到的定义
     */
    private findDefinitionInFileInfo(fileInfo: FileInfo, word: string): AngularDefinition | null {
        const definitionTypes: (keyof FileInfo)[] = ['controllers', 'services', 'directives', 'functions', 'scopeVariables', 'components'];
        for (const type of definitionTypes) {
            const definitions = fileInfo[type];
            if (definitions instanceof Map) {
                const definition = definitions.get(word);
                if (definition) {
                    return definition;
                }
            }
        }
        return null;
    }

    /**
     * 在当前 HTML 文件中查找定义
     * @param {string} word - 要查找的单词
     * @param {vscode.TextDocument} document - 当前文档
     * @returns {vscode.Location | null} 定义位置
     */
    private findDefinitionInCurrentHtml(word: string, document: vscode.TextDocument): vscode.Location | null {
        const content = document.getText();
        // 使用正则表达式查找 ng- 属性
        const regex = new RegExp(`ng-[a-zA-Z-]+="${word}"`, 'g');
        const matches = Array.from(content.matchAll(regex));

        for (const match of matches) {
            if (match.index !== undefined) {
                // 返回找到的位置
                return new vscode.Location(
                    document.uri,
                    document.positionAt(match.index)
                );
            }
        }

        return null;
    }

    /**
     * 在 HTML 文件中查找定义
     * @param {string} word - 要查找的单词
     * @returns {vscode.Location | null} 定义位置
     */
    private findDefinitionInHtml(word: string): vscode.Location | null {
        const allFiles = this.angularParser.getAllParsedFiles();
        for (const fileName of allFiles) {
            const fileInfo = this.angularParser.getFileInfo(fileName);
            if (fileInfo) {
                const attribute = fileInfo.ngAttributes.get(word);
                if (attribute) {
                    return new vscode.Location(
                        vscode.Uri.file(fileName),
                        this.positionFromOffset(attribute.position, fileName)
                    );
                }

                const controller = fileInfo.ngControllers.get(word);
                if (controller) {
                    return new vscode.Location(
                        vscode.Uri.file(fileName),
                        this.positionFromOffset(controller.position, fileName)
                    );
                }
            }
        }
        return null;
    }

    /**
     * 将偏移量转换为 Position 对象
     * @param {number} offset - 偏移量
     * @param {string} fileName - 文件名
     * @returns {vscode.Position} 转换后的 Position 对象
     */
    private positionFromOffset(offset: number, fileName: string): vscode.Position {
        const document = vscode.workspace.textDocuments.find(doc => doc.fileName === fileName);
        if (document) {
            return document.positionAt(offset);
        }
        return new vscode.Position(0, 0);
    }
}
