import * as vscode from 'vscode';
import * as ts from 'typescript';
import { FileInfo, AngularDefinition } from '../types/types';

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
        const sourceFile = ts.createSourceFile(
            'inline.js',
            content,
            ts.ScriptTarget.Latest,
            true
        );

        this.parseNode(sourceFile, fileInfo, document);
    }

    private parseNode(node: ts.Node, fileInfo: FileInfo, document: vscode.TextDocument): void {
        if (ts.isExpressionStatement(node)) {
            this.handleExpressionStatement(fileInfo, node, document);
        } else if (ts.isCallExpression(node)) {
            this.handleCallExpression(fileInfo, node, document);
        }

        ts.forEachChild(node, child => this.parseNode(child, fileInfo, document));
    }

    private handleExpressionStatement(fileInfo: FileInfo, node: ts.ExpressionStatement, document: vscode.TextDocument) {
        if (ts.isBinaryExpression(node.expression) && node.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
            const left = node.expression.left;
            const right = node.expression.right;
            if (ts.isPropertyAccessExpression(left)) {
                const object = left.expression;
                const property = left.name;
                if (ts.isIdentifier(object) && ts.isIdentifier(property) && object.text === '$scope') {
                    if (ts.isFunctionExpression(right) || ts.isArrowFunction(right)) {
                        const position = document.offsetAt(document.positionAt(property.getStart()));
                        this.addScopeFunction(fileInfo, property.text, position, true);
                    } else {
                        const position = document.offsetAt(document.positionAt(property.getStart()));
                        this.addScopeVariable(fileInfo, property.text, position);
                    }
                }
            }
        }
    }

    private handleCallExpression(fileInfo: FileInfo, node: ts.CallExpression, document: vscode.TextDocument) {
        if (ts.isPropertyAccessExpression(node.expression)) {
            const object = node.expression.expression;
            const property = node.expression.name;
            if (ts.isIdentifier(object) && ts.isIdentifier(property)) {
                if (object.text === '$scope') {
                    const position = document.offsetAt(document.positionAt(property.getStart()));
                    this.addScopeFunction(fileInfo, property.text, position, false);
                }
                // 移除这部分，因为它可能导致错误的引用
                // else {
                //     const position = document.offsetAt(document.positionAt(property.getStart()));
                //     this.addFunctionReference(fileInfo, property.text, position);
                // }
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

    private addScopeVariable(fileInfo: FileInfo, name: string, position: number) {
        fileInfo.scopeVariables.set(name, {
            name,
            position,
            type: 'variable',
            isDefinition: true
        });
    }

    private addFunctionReference(fileInfo: FileInfo, name: string, position: number) {
        if (!fileInfo.functions.has(name)) {
            fileInfo.functions.set(name, []);
        }
        fileInfo.functions.get(name)!.push({
            name,
            position,
            type: 'function',
            isDefinition: false
        });
    }
}
