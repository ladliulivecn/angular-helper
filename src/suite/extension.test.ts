import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import { AngularParser } from '../angularParser';
import { DefinitionProvider } from '../definitionProvider';
import { setOutputChannel } from '../extension';
import { FileUtils } from '../utils/FileUtils';
import { ReferenceProvider } from '../referenceProvider';

suite('Angular Helper Extension Test Suite', () => {
    let angularParser: AngularParser;
    let definitionProvider: DefinitionProvider;
    let referenceProvider: ReferenceProvider;
    const TEST_FILES_PATH = path.join(__dirname, '..', '..', 'src', 'test');

    setup(() => {
        angularParser = new AngularParser();
        definitionProvider = new DefinitionProvider(angularParser);
        referenceProvider = new ReferenceProvider(angularParser);
        // 创建一个模拟的 OutputChannel
        const mockOutputChannel = {
            appendLine: (value: string) => {
                // 可以在这里添加一些断言或日志,如果需要的话
                console.log(value);
            }
        };
        const mockWorkspacePath = path.join(__dirname, '../../');
        angularParser.setMockWorkspacePath(mockWorkspacePath);
        // 设置模拟的 OutputChannel
        setOutputChannel(mockOutputChannel as any as vscode.OutputChannel);
        
        // 检查工作区路径是否正确设置
        assert.strictEqual(angularParser['mockWorkspacePath'], mockWorkspacePath, '工作区路径设置不正确');
    });

    test('HTML 解析 - Script 标签和 ng-* 属性', async () => {
        const testFilePath = path.join(TEST_FILES_PATH, 'temp2.html');
        const jsUri = vscode.Uri.file(path.join(TEST_FILES_PATH, 'temp2.js'));
        const uri = vscode.Uri.file(testFilePath);
        await angularParser.parseFile(uri);
        const fileInfo = angularParser.getFileInfo(testFilePath);

        assert.ok(fileInfo, 'fileInfo 应该存在');
        assert.ok(angularParser.getAssociatedJsFiles(testFilePath).includes(jsUri.fsPath), '应该关联到 temp2.js');

        assert.ok(fileInfo.ngAttributes, 'ngAttributes 应该存在');
        assert.strictEqual(fileInfo.ngAttributes.size > 0, true, 'ngAttributes 不应为空');
        
        // 修改这里，使用 has 方法检查属性是否存在
        assert.ok(fileInfo.ngAttributes.has('app'), '应包含 ng-app 或 app');
        assert.ok(fileInfo.ngAttributes.has('controller'), '应包含 ng-controller 或 controller');
        assert.ok(fileInfo.ngAttributes.has('model') || fileInfo.ngAttributes.has('bind'), '应包含 ng-model 或 ng-bind');
        assert.ok(fileInfo.ngAttributes.has('click'), '应包含 ng-click');
    });

    test('函数定义和引用测试', async () => {
        const htmlUri = vscode.Uri.file(path.join(TEST_FILES_PATH, 'temp2.html'));
        const jsUri = vscode.Uri.file(path.join(TEST_FILES_PATH, 'temp2.js'));

        FileUtils.log(`解析 HTML 文件: ${htmlUri.fsPath}`);
        await angularParser.parseFile(htmlUri);

        const htmlDocument = await vscode.workspace.openTextDocument(htmlUri);
        let jsDocument: vscode.TextDocument | undefined; 
        try {
            jsDocument = await vscode.workspace.openTextDocument(jsUri);
            FileUtils.log(`成功打开 JS 文件: ${jsUri.fsPath}`);
            
            // 检查关联
            const associatedJsFiles = angularParser.getAssociatedJsFiles(htmlUri.fsPath);
            FileUtils.log(`HTML 文件关联的 JS 文件: ${associatedJsFiles.join(', ')}`);
            
            if (associatedJsFiles.includes(jsUri.fsPath)) {
                FileUtils.log(`JS 文件 ${jsUri.fsPath} 是 HTML 文件的关联文件`);
                const jsFileInfo = angularParser.getFileInfo(jsUri.fsPath);
                if (jsFileInfo) {
                    FileUtils.log(`找到 JS 文件信息: ${jsUri.fsPath}`);
                } else {
                    FileUtils.log(`未找到 JS 文件信息: ${jsUri.fsPath}`);
                    // 检查 fileMap 中的所有键
                    const allParsedFiles = angularParser.getAllParsedFiles();
                    for (const key of allParsedFiles) {
                        FileUtils.log(key);
                    }
                }
            } else {
                FileUtils.log(`JS文件 ${jsUri.fsPath} 不是HTML文件的关联文件，这是意外情况`);
            } 
        } catch (error) {
            FileUtils.log(`未找到 JS 文件: ${jsUri.fsPath}, 可能 JavaScript 代码在 HTML 文件中`);
        } 
            
        const functionsToTest = ['selectCost', 'ShowQrcode', 'GotoLearder', 'GotoSign', 'togglePage', 'GotoField'];

        for (const func of functionsToTest) {
            FileUtils.log(`测试函数: ${func}`);
            const htmlFileInfo = angularParser.getFileInfo(htmlUri.fsPath);
            const jsFileInfo = jsDocument ? angularParser.getFileInfo(jsUri.fsPath) : undefined;

            assert.notStrictEqual(htmlFileInfo, undefined, `未找到 HTML 文件信息: ${htmlUri.fsPath}`);
            
            const htmlFunction = htmlFileInfo!.functions.get(func) ? htmlFileInfo!.functions.get(func)![0] : undefined;
            const jsFunction = jsFileInfo?.functions.get(func) ? jsFileInfo.functions.get(func)![0] : undefined;

            // 检查函数定义
            const definition = (jsFunction && jsFunction.isDefinition) ? jsFunction : 
                               (htmlFunction && htmlFunction.isDefinition) ? htmlFunction : undefined;

            if (definition) {
                const definitionUri = definition === jsFunction ? jsUri : htmlUri;
                const definitionDocument = definition === jsFunction ? jsDocument! : htmlDocument;
                const definitionPosition = angularParser.getPositionLocation(definitionUri.fsPath, definition.position);
                FileUtils.log(`找到函数 ${func} 的定义`);
                FileUtils.log(`定义位置: ${definitionUri.fsPath}, 行 ${definitionPosition.line + 1}, 列 ${definitionPosition.character + 1}`);

                const foundDefinition = await definitionProvider.provideDefinition(definitionDocument, definitionPosition, null as any);
                assert.notStrictEqual(foundDefinition, undefined, `应该找到 ${func} 的定义`);
                assert.ok(foundDefinition instanceof vscode.Location, `${func} 的定义应该是 Location 类型`);
            } else {
                FileUtils.log(`未找到函数 ${func} 的定义，只找到引用`);
                const reference = jsFunction || htmlFunction;
                if (reference) {
                    const referenceUri = reference === jsFunction ? jsUri : htmlUri;
                    const referencePosition = angularParser.getPositionLocation(referenceUri.fsPath, reference.position);
                    FileUtils.log(`函数 ${func} 的引用在 ${referenceUri.fsPath} 中`);
                    FileUtils.log(`引用位置: 行 ${referencePosition.line + 1}, 列 ${referencePosition.character + 1}`);
                }
            }

            // 测试引用查找
            const referencePosition = definition ? 
                angularParser.getPositionLocation(definition === jsFunction ? jsUri.fsPath : htmlUri.fsPath, definition.position) :
                (htmlFunction ? angularParser.getPositionLocation(htmlUri.fsPath, htmlFunction.position) :
                 (jsFunction ? angularParser.getPositionLocation(jsUri.fsPath, jsFunction.position) : new vscode.Position(0, 0)));
            
            const referenceDocument = definition ? 
                (definition === jsFunction ? jsDocument! : htmlDocument) :
                (htmlFunction ? htmlDocument : (jsFunction ? jsDocument! : htmlDocument));

            const references = await referenceProvider.provideReferences(referenceDocument, referencePosition, { includeDeclaration: false }, null as any);

            if (references && references.length > 0) {
                FileUtils.log(`函数 ${func} 的所有引用:`);
                references.forEach((ref: vscode.Location, index: number) => {
                    FileUtils.log(`  引用 ${index + 1}: 文件 ${ref.uri.fsPath}, 行 ${ref.range.start.line + 1}, 列 ${ref.range.start.character + 1}`);
                });
                
                // 检查是否在 HTML 或 JS 文件中有引用
                assert.ok(
                    references.some((ref: vscode.Location) => 
                        ref.uri.fsPath === htmlUri.fsPath || (jsDocument && ref.uri.fsPath === jsUri.fsPath)
                    ),
                    `${func} 应该在HTML或JS文件中有引用`
                );
            } else {
                FileUtils.log(`未找到 ${func} 的引用`);
            }
        }
    });

    test('HTML 解析 - ng-* 属性和函数引用', async () => {
        const testFilePath = path.join(TEST_FILES_PATH, 'temp2.html');
        const uri = vscode.Uri.file(testFilePath);
        await angularParser.parseFile(uri);
        const fileInfo = angularParser.getFileInfo(testFilePath);

        assert.ok(fileInfo, 'fileInfo 应该存在');
        assert.ok(fileInfo.ngAttributes, 'ngAttributes 应该存在');
        assert.strictEqual(fileInfo.ngAttributes.size > 0, true, 'ngAttributes 不应为空');
        
        // 检查是否捕获了常见的 ng-* 属性
        assert.ok(fileInfo.ngAttributes.has('app'), '应包含 ng-app');
        assert.ok(fileInfo.ngAttributes.has('controller'), '应包含 ng-controller');
        assert.ok(fileInfo.ngAttributes.has('click') || fileInfo.ngAttributes.has('change'), '应包含 ng-click 或 ng-change');

        // 检查是否正确捕获了函数引用
        assert.ok(fileInfo.functions.size > 0, '应该捕获到函数引用');
        assert.ok(fileInfo.functions.has('selectCost'), '应该捕获到 selectCost 函数');
        assert.ok(fileInfo.functions.has('GotoSign'), '应该捕获到 GotoSign 函数');

        // 检查 selectCost 函数的引用
        const selectCostReferences = fileInfo.functions.get('selectCost') || [];
        assert.strictEqual(selectCostReferences.length >= 4, true, 'selectCost 函数应该至少有4个引用');

        // 检查 GotoSign 函数的引用
        const gotoSignReferences = fileInfo.functions.get('GotoSign') || [];
        assert.strictEqual(gotoSignReferences.length >= 2, true, 'GotoSign 函数应该至少有两个引用');

        // 验证特定的引用位置
        const expectedReferences = [
            { line: 929, character: 62 },
            { line: 1172, character: 74 }
        ];

        expectedReferences.forEach(expected => {
            const found = gotoSignReferences.some(ref => {
                const loc = angularParser.getPositionLocation(testFilePath, ref.position);
                return loc.line === expected.line - 1 && loc.character === expected.character - 1;
            });
            assert.ok(found, `应该在行 ${expected.line}, 列 ${expected.character} 找到 GotoSign 的引用`);
        });

        FileUtils.log(`捕获到的 ng-* 属性数量: ${fileInfo.ngAttributes.size}`);
        FileUtils.log(`捕获到的函数引用数量: ${fileInfo.functions.size}`);
        
    });

    // TODO: 如果需要，可以在这里添加更多针对 HTML 文件的测试...
});
