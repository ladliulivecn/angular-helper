import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import { AngularParser } from '../angularParser';
import { DefinitionProvider } from '../definitionProvider';
import { setOutputChannel } from '../extension';

suite('Angular Helper Extension Test Suite', () => {
    let angularParser: AngularParser;
    let definitionProvider: DefinitionProvider;
    const TEST_FILES_PATH = path.join(__dirname, '..', '..', 'src', 'test');

    setup(() => {
        angularParser = new AngularParser();
        definitionProvider = new DefinitionProvider(angularParser);
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
        const uri = vscode.Uri.file(testFilePath);
        await angularParser.parseFile(uri);
        const fileInfo = angularParser.getFileInfo(testFilePath);

        assert.ok(fileInfo, 'fileInfo 应该存在');
        assert.ok(angularParser.getAssociatedJsFiles(testFilePath).includes('temp2.js'), '应该关联到 temp2.js');

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

        await angularParser.parseFile(htmlUri);

        const htmlDocument = await vscode.workspace.openTextDocument(htmlUri);
        const jsDocument = await vscode.workspace.openTextDocument(jsUri);

        const functionsToTest = ['selectCost', 'showQrcode', 'GotoLearder', 'GotoSign', 'togglePage', 'GotoField'];

        for (const func of functionsToTest) {
            // 测试 HTML 到 JS 的定义查找
            const htmlFileInfo = angularParser.getFileInfo(htmlUri.fsPath);
            assert.notStrictEqual(htmlFileInfo, undefined, `未找到 HTML 文件信息: ${htmlUri.fsPath}`);
            const htmlFunction = htmlFileInfo!.functions.get(func);
            
            assert.notStrictEqual(htmlFunction, undefined, `未找到函数 ${func} 在HTML中的引用`);
            const htmlPosition = angularParser.getPositionLocation(htmlUri.fsPath, htmlFunction!.position);

            const definition = definitionProvider.provideDefinition(htmlDocument, htmlPosition, null as any);
            
            assert.notStrictEqual(definition, undefined, `应该找到 ${func} 的定义`);
            assert.ok(definition instanceof vscode.Location, `${func} 的定义应该是 Location 类型`);
            assert.strictEqual(definition.uri.fsPath, jsUri.fsPath, `${func} 的定义应该在JS文件中`);

            // 测试 JS 到 HTML 的引用查找
            const jsFileInfo = angularParser.getFileInfo(jsUri.fsPath);
            assert.notStrictEqual(jsFileInfo, undefined, `未找到 JS 文件信息: ${jsUri.fsPath}`);
            const jsFunction = jsFileInfo!.functions.get(func);
            
            assert.notStrictEqual(jsFunction, undefined, `未找到函数 ${func} 在JS中的定义`);
            const jsPosition = angularParser.getPositionLocation(jsUri.fsPath, jsFunction!.position);

            // 使用 DefinitionProvider 的 findReferences 方法
            const references = await definitionProvider.provideReferences(jsDocument, jsPosition, { includeDeclaration: false }, null as any);

            assert.notStrictEqual(references, undefined, `应该找到 ${func} 的引用`);
            assert.ok(Array.isArray(references), `${func} 的引用应该是一个数组`);
            assert.ok(references.length > 0, `应该找到 ${func} 的引用`);
            assert.ok(
                references.some((ref: vscode.Location) => ref.uri.fsPath === htmlUri.fsPath),
                `${func} 应该在HTML文件中有引用`
            );
        }
    });

    // TODO: 如果需要，可以在这里添加更多针对 HTML 文件的测试...
});
