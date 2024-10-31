import * as ts from 'typescript';
import * as vscode from 'vscode';
import { FileInfo } from '../types/types';
import { FileUtils } from '../utils/FileUtils';

export class JavaScriptParser {
    constructor() {}

    public parseJavaScriptFile(document: vscode.TextDocument): FileInfo {
        const fileInfo: FileInfo = {
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

        const sourceFile = ts.createSourceFile(
            document.fileName,
            document.getText(),
            ts.ScriptTarget.Latest,
            true
        );

        this.parseNode(sourceFile, fileInfo, document);

        return fileInfo;
    }

    public parseJavaScriptContent(content: string, fileInfo: FileInfo, document: vscode.TextDocument): void {
        const scriptStartPosition = this.findScriptPosition(content, document);
        
        const sourceFile = ts.createSourceFile(
            'inline.js',
            content,
            ts.ScriptTarget.Latest,
            true
        );

        this.parseNode(sourceFile, fileInfo, document, scriptStartPosition);
    }

    private parseNode(node: ts.Node, fileInfo: FileInfo, document: vscode.TextDocument, scriptStartPosition: number = 0): void {
        if (ts.isExpressionStatement(node)) {
            this.handleExpressionStatement(fileInfo, node, document, scriptStartPosition);
        } else if (ts.isCallExpression(node)) {
            this.handleCallExpression(fileInfo, node, document, scriptStartPosition);
        }

        ts.forEachChild(node, child => this.parseNode(child, fileInfo, document, scriptStartPosition));
    }

    private handleExpressionStatement(fileInfo: FileInfo, node: ts.ExpressionStatement, document: vscode.TextDocument, scriptStartPosition: number) {
        if (ts.isBinaryExpression(node.expression) && node.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
            const left = node.expression.left;
            const right = node.expression.right;
            if (ts.isPropertyAccessExpression(left)) {
                const object = left.expression;
                const property = left.name;
                if (ts.isIdentifier(object) && ts.isIdentifier(property) && object.text === '$scope') {
                    const position = scriptStartPosition + property.getStart();
                    
                    if (ts.isFunctionExpression(right) || ts.isArrowFunction(right)) {
                        this.addScopeFunction(fileInfo, property.text, position, true);
                        const pos = document.positionAt(position);
                        FileUtils.logDebugForFindDefinitionAndReference(
                            `找到 $scope 函数定义: ${property.text}, 位置: ${document.fileName}, ` +
                            `行 ${pos.line + 1}, 列 ${pos.character + 1}, ` +
                            `脚本开始位置: ${scriptStartPosition}, 节点位置: ${property.getStart()}, 最终位置: ${position}`
                        );
                    } else {
                        this.addScopeVariable(fileInfo, property.text, position, true);
                    }
                }
            }
        }
    }

    private addScopeFunction(fileInfo: FileInfo, name: string, position: number, isDefinition: boolean) {
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

    private addScopeVariable(fileInfo: FileInfo, name: string, position: number, isDefinition: boolean) {
        const existingVariable = fileInfo.scopeVariables.get(name);
        
        if (existingVariable) {
            if (isDefinition && position < existingVariable.position) {
                fileInfo.scopeVariables.set(name, {
                    name,
                    position,
                    type: 'variable',
                    isDefinition: true
                });
            }
        } else {
            fileInfo.scopeVariables.set(name, {
                name,
                position,
                type: 'variable',
                isDefinition
            });
        }

        if (!fileInfo.functions.has(name)) {
            fileInfo.functions.set(name, []);
        }
        fileInfo.functions.get(name)!.push({
            name,
            position,
            type: 'variable',
            isDefinition: false
        });
    }

    private handleCallExpression(fileInfo: FileInfo, node: ts.CallExpression, document: vscode.TextDocument, scriptStartPosition: number) {
        if (ts.isPropertyAccessExpression(node.expression) && 
            ts.isIdentifier(node.expression.expression) &&
            node.expression.expression.text === 'app' &&
            ts.isIdentifier(node.expression.name) &&
            node.expression.name.text === 'filter') {

            if (node.arguments.length >= 1 && ts.isStringLiteral(node.arguments[0])) {
                const filterName = node.arguments[0].text;
                const position = document.offsetAt(document.positionAt(node.arguments[0].getStart()));

                if (!fileInfo.filters.has(filterName)) {
                    fileInfo.filters.set(filterName, []);
                }

                fileInfo.filters.get(filterName)!.push({
                    name: filterName,
                    position,
                    type: 'filter',
                    isDefinition: true
                });

                FileUtils.logDebugForFindDefinitionAndReference(
                    `找到 filter 定义: ${filterName}, 位置: ${document.fileName}, ` +
                    `行 ${document.positionAt(position).line + 1}, ` +
                    `列 ${document.positionAt(position).character + 1}`
                );
            }
        }

        if (ts.isPropertyAccessExpression(node.expression)) {
            const object = node.expression.expression;
            const property = node.expression.name;
            
            if (ts.isIdentifier(object) && 
                ts.isIdentifier(property) && 
                object.text === '$scope') {
                
                const position = scriptStartPosition + property.getStart();
                
                this.addScopeFunction(fileInfo, property.text, position, false);
                
                const pos = document.positionAt(position);
                FileUtils.logDebugForFindDefinitionAndReference(
                    `找到 $scope 函数引用: ${property.text}, 位置: ${document.fileName}, ` +
                    `行 ${pos.line + 1}, 列 ${pos.character + 1}, ` +
                    `脚本开始位置: ${scriptStartPosition}, 节点位置: ${property.getStart()}, 最终位置: ${position}`
                );
            }
        }
    }

    private findScriptPosition(scriptContent: string, document: vscode.TextDocument): number {
        const fullContent = document.getText();
        const scriptIndex = fullContent.indexOf(scriptContent);
        return scriptIndex >= 0 ? scriptIndex : 0;
    }
}
