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
        FileUtils.logDebugForFindDefinitionAndReference(
            `开始解析JavaScript内容, 文件: ${document.fileName}`
        );

        const scriptStartPosition = this.findScriptPosition(content, document);
        FileUtils.logDebugForFindDefinitionAndReference(
            `脚本开始位置: ${scriptStartPosition}`
        );
        
        try {
            const sourceFile = ts.createSourceFile(
                'inline.js',
                content,
                ts.ScriptTarget.Latest,
                true
            );

            FileUtils.logDebugForFindDefinitionAndReference(
                `创建源文件成功, AST节点类型: ${ts.SyntaxKind[sourceFile.kind]}`
            );

            // 添加AST结构日志
            // this.logASTStructure(sourceFile, 0);

            this.parseNode(sourceFile, fileInfo, document, scriptStartPosition);

            FileUtils.logDebugForFindDefinitionAndReference(
                `JavaScript内容解析完成, 找到的函数数量: ${fileInfo.functions.size}, ` +
                `变量数量: ${fileInfo.scopeVariables.size}`
            );
        } catch (error) {
            FileUtils.logDebugForFindDefinitionAndReference(
                `解析JavaScript内容时发生错误: ${error}`
            );
        }
    }

    private parseNode(node: ts.Node, fileInfo: FileInfo, document: vscode.TextDocument, scriptStartPosition: number = 0): void {
        FileUtils.logDebugForFindDefinitionAndReference(
            `解析节点: ${ts.SyntaxKind[node.kind]}, ` +
            `位置: ${scriptStartPosition + node.getStart()}-${scriptStartPosition + node.getEnd()}, ` +
            `内容: ${node.getText().substring(0, 100)}`
        );

        if (ts.isVariableStatement(node)) {
            FileUtils.logDebugForFindDefinitionAndReference(
                `处理变量声明语句: ${node.getText()}`
            );
            this.handleVariableStatement(fileInfo, node, document, scriptStartPosition);
        } else if (ts.isExpressionStatement(node)) {
            FileUtils.logDebugForFindDefinitionAndReference(
                `处理表达式语句: ${node.getText()}`
            );
            this.handleExpressionStatement(fileInfo, node, document, scriptStartPosition);
        } else if (ts.isCallExpression(node)) {
            FileUtils.logDebugForFindDefinitionAndReference(
                `处理函数调用: ${node.getText()}`
            );
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
                let propertyChain: string[] = [];
                let current: ts.Expression = left;
                
                // 收集完整的属性访问链
                while (ts.isPropertyAccessExpression(current)) {
                    if (ts.isIdentifier(current.name)) {
                        propertyChain.unshift(current.name.text);
                    }
                    current = current.expression;
                }
                
                // 检查是否是 $scope 属性链
                if (ts.isIdentifier(current) && current.text === '$scope') {
                    const fullPropertyName = propertyChain.join('.');
                    const position = scriptStartPosition + left.getStart();
                    
                    if (ts.isFunctionExpression(right) || ts.isArrowFunction(right)) {
                        // 处理函数定义
                        this.addScopeFunction(fileInfo, fullPropertyName, position, true);
                        FileUtils.logDebugForFindDefinitionAndReference(
                            `找到 $scope 函数定义: ${fullPropertyName}, 位置: ${document.fileName}, ` +
                            `行 ${document.positionAt(position).line + 1}, ` +
                            `列 ${document.positionAt(position).character + 1}`
                        );
                    } else {
                        // 处理变量定义
                        this.addScopeVariable(fileInfo, fullPropertyName, position, true);
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
        // 去掉 $scope. 前缀
        const normalizedName = name.startsWith('$scope.') ? name.substring(7) : name;
        
        if (!fileInfo.functions.has(normalizedName)) {
            fileInfo.functions.set(normalizedName, []);
        }
        
        fileInfo.functions.get(normalizedName)!.push({
            name: normalizedName,
            position,
            type: 'function',
            isDefinition
        });
        
        FileUtils.logDebugForFindDefinitionAndReference(
            `添加函数${isDefinition ? '定义' : '引用'}: ${normalizedName}, 位置: ${position}`
        );
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
        
        // 检查是否已存在相同位置的引用
        const existingRefs = fileInfo.functions.get(normalizedName)!;
        if (!existingRefs.some(ref => ref.position === position)) {
            // 只有当该位置不存在引用时才添加
            existingRefs.push({
                name: normalizedName,
                position,
                type: 'variable',
                isDefinition
            });

            FileUtils.logDebugForFindDefinitionAndReference(
                `添加变量引用到 functions 集合: ${normalizedName}, 位置: ${position}, 是否定义: ${isDefinition}`
            );
        }
    }

    private findScriptPosition(scriptContent: string, document: vscode.TextDocument): number {
        const fullContent = document.getText();
        const scriptIndex = fullContent.indexOf(scriptContent);
        return scriptIndex >= 0 ? scriptIndex : 0;
    }

    // 添加一个辅助方法来打印AST结构
    private logASTStructure(node: ts.Node, depth: number): void {
        const indent = '  '.repeat(depth);
        FileUtils.logDebugForFindDefinitionAndReference(
            `${indent}${ts.SyntaxKind[node.kind]}`
        );
        
        node.forEachChild(child => {
            this.logASTStructure(child, depth + 1);
        });
    }

    private handleVariableStatement(fileInfo: FileInfo, node: ts.VariableStatement, document: vscode.TextDocument, scriptStartPosition: number): void {
        FileUtils.logDebugForFindDefinitionAndReference(
            `处理变量声明语句: ${node.getText()}`
        );

        // 遍历所有变量声明
        node.declarationList.declarations.forEach(declaration => {
            if (ts.isIdentifier(declaration.name)) {
                const variableName = declaration.name.text;
                const position = scriptStartPosition + declaration.name.getStart();

                // 检查初始化表达式
                if (declaration.initializer) {
                    if (ts.isFunctionExpression(declaration.initializer) || ts.isArrowFunction(declaration.initializer)) {
                        // 如果初始化为函数表达式，添加为函数定义
                        this.addScopeFunction(fileInfo, variableName, position, true);
                        FileUtils.logDebugForFindDefinitionAndReference(
                            `找到函数定义: ${variableName}, 位置: ${document.fileName}, ` +
                            `行 ${document.positionAt(position).line + 1}, ` +
                            `列 ${document.positionAt(position).character + 1}`
                        );
                    } else {
                        // 否则添加为变量定义
                        this.addScopeVariable(fileInfo, variableName, position, true);
                        FileUtils.logDebugForFindDefinitionAndReference(
                            `找到变量定义: ${variableName}, 位置: ${document.fileName}, ` +
                            `行 ${document.positionAt(position).line + 1}, ` +
                            `列 ${document.positionAt(position).character + 1}`
                        );
                    }

                    // 递归解析初始化表达式中的引用
                    this.findScopeReferences(declaration.initializer, fileInfo, document, scriptStartPosition);
                } else {
                    // 没有初始化表达式的变量声明
                    this.addScopeVariable(fileInfo, variableName, position, true);
                    FileUtils.logDebugForFindDefinitionAndReference(
                        `找到未初始化的变量定义: ${variableName}, 位置: ${document.fileName}, ` +
                        `行 ${document.positionAt(position).line + 1}, ` +
                        `列 ${document.positionAt(position).character + 1}`
                    );
                }
            } else if (ts.isObjectBindingPattern(declaration.name)) {
                // 处理解构赋值
                declaration.name.elements.forEach(element => {
                    if (ts.isBindingElement(element) && ts.isIdentifier(element.name)) {
                        const variableName = element.name.text;
                        const position = scriptStartPosition + element.name.getStart();
                        
                        this.addScopeVariable(fileInfo, variableName, position, true);
                        FileUtils.logDebugForFindDefinitionAndReference(
                            `找到解构赋值变量定义: ${variableName}, 位置: ${document.fileName}, ` +
                            `行 ${document.positionAt(position).line + 1}, ` +
                            `列 ${document.positionAt(position).character + 1}`
                        );
                    }
                });

                if (declaration.initializer) {
                    this.findScopeReferences(declaration.initializer, fileInfo, document, scriptStartPosition);
                }
            }
        });
    }
}
