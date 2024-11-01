import * as ts from 'typescript';
import * as vscode from 'vscode';
import { FileInfo } from '../types/types';
import { FileInfoFactory } from '../utils/FileInfoFactory';
import { FileUtils } from '../utils/FileUtils';
import { ParserBase } from './ParserBase';

export class JavaScriptParser extends ParserBase {
    constructor() {
        super();
    }

    public parseJavaScriptFile(document: vscode.TextDocument): FileInfo {
        const filePath = document.uri.fsPath;
        if (this.isFileBeingParsed(filePath)) {
            FileUtils.logDebugForAssociations(`跳过正在解析的JS文件: ${filePath}`);
            return FileInfoFactory.createEmpty(filePath);
        }

        this.markFileAsParsing(filePath);
        try {
            const fileInfo = FileInfoFactory.createEmpty(filePath);
            
            const sourceFile = ts.createSourceFile(
                document.fileName,
                document.getText(),
                ts.ScriptTarget.Latest,
                true
            );

            this.parseNode(sourceFile, fileInfo, document);

            return fileInfo;
        } finally {
            this.markFileAsFinishedParsing(filePath);
        }
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
        } else {
            this.findScopeReferences(node, fileInfo, document, scriptStartPosition);
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
                    } else {
                        this.addScopeVariable(fileInfo, property.text, position, true);
                    }
                }
            }
        }

        this.findScopeReferences(node, fileInfo, document, scriptStartPosition);
    }

    private findScopeReferences(node: ts.Node, fileInfo: FileInfo, document: vscode.TextDocument, scriptStartPosition: number) {
        if (ts.isPropertyAccessExpression(node)) {
            // 收集完整的属性访问链
            const propertyChain: string[] = [];
            let current: ts.Expression = node;
            let originalNode = node;  // 保存原始节点
            
            // 从最深层的属性开始向上收集
            while (ts.isPropertyAccessExpression(current)) {
                if (ts.isIdentifier(current.name)) {
                    propertyChain.unshift(current.name.text);
                }
                current = current.expression;
            }

            // 检查是否以 $scope 开头
            if (ts.isIdentifier(current) && current.text === '$scope') {
                if (propertyChain.length > 0) {
                    const firstProp = propertyChain[0];
                    const firstPropPosition = scriptStartPosition + node.getStart() + 
                        node.getText().indexOf(firstProp);
                    
                    this.addScopeVariable(fileInfo, firstProp, firstPropPosition, false);
                    
                    let partialPath = firstProp;
                    
                    for (let i = 1; i < propertyChain.length; i++) {
                        partialPath += '.' + propertyChain[i];
                        
                        const propPosition = scriptStartPosition + node.getStart() + 
                            node.getText().indexOf(partialPath);
                        
                        this.addScopeVariable(fileInfo, partialPath, propPosition, false);
                        
                        FileUtils.logDebugForFindDefinitionAndReference(
                            `找到 $scope 属性链引用: ${partialPath}, 位置: ${document.fileName}, ` +
                            `行 ${document.positionAt(propPosition).line + 1}, ` +
                            `列 ${document.positionAt(propPosition).character + 1}`
                        );
                    }
                }
            }
        } else if (ts.isCallExpression(node)) {
            // 处理方法调用
            const expression = node.expression;
            if (ts.isPropertyAccessExpression(expression)) {
                this.findScopeReferences(expression, fileInfo, document, scriptStartPosition);
            }
        }

        ts.forEachChild(node, child => this.findScopeReferences(child, fileInfo, document, scriptStartPosition));
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
            this.findScopeReferences(node.expression, fileInfo, document, scriptStartPosition);
        }

        node.arguments.forEach(arg => {
            this.findScopeReferences(arg, fileInfo, document, scriptStartPosition);
        });
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
        // 去掉 $scope. 前缀
        const normalizedName = name.startsWith('$scope.') ? name.substring(7) : name;

        // 添加到 scopeVariables
        const existingVariable = fileInfo.scopeVariables.get(normalizedName);
        
        if (existingVariable) {
            if (isDefinition && position < existingVariable.position) {
                fileInfo.scopeVariables.set(normalizedName, {
                    name: normalizedName,
                    position,
                    type: 'variable',
                    isDefinition: true
                });
            }
        } else {
            fileInfo.scopeVariables.set(normalizedName, {
                name: normalizedName,
                position,
                type: 'variable',
                isDefinition
            });
        }

        // 添加到 functions 集合中用于引用查找
        if (!fileInfo.functions.has(normalizedName)) {
            fileInfo.functions.set(normalizedName, []);
        }
        
        // 直接添加引用，不进行重复检查
        fileInfo.functions.get(normalizedName)!.push({
            name: normalizedName,
            position,
            type: 'variable',
            isDefinition
        });

        FileUtils.logDebugForFindDefinitionAndReference(
            `添加变量引用到 functions 集合: ${normalizedName}, 位置: ${position}, 是否定义: ${isDefinition}`
        );
    }

    private findScriptPosition(scriptContent: string, document: vscode.TextDocument): number {
        const fullContent = document.getText();
        const scriptIndex = fullContent.indexOf(scriptContent);
        return scriptIndex >= 0 ? scriptIndex : 0;
    }
}
