import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';
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

    test('跳转位置测试', async () => {
        const htmlUri = vscode.Uri.file(path.join(TEST_FILES_PATH, 'temp2.html'));
        const jsUri = vscode.Uri.file(path.join(TEST_FILES_PATH, 'temp2.js'));

        await angularParser.parseFile(htmlUri);

        const htmlDocument = await vscode.workspace.openTextDocument(htmlUri);
        const jsDocument = await vscode.workspace.openTextDocument(jsUri);

        const functionsToTest = ['anotherFunction', 'showQrcode', 'hideQrcode'];

        for (const func of functionsToTest) {
            // 在 HTML 中查找函数引用
            const htmlPosition = findPositionOfVariable(htmlDocument, func);
            assert.notStrictEqual(htmlPosition, undefined, `未找到函数 ${func} 在HTML中的引用`);

            // 检查函数定义
            const definition = await vscode.commands.executeCommand<vscode.Location[]>(
                'vscode.executeDefinitionProvider',
                htmlUri,
                htmlPosition!
            );

            assert.strictEqual(definition?.length, 1, `应该只找到一个 ${func} 的定义`);
            assert.strictEqual(definition[0].uri.fsPath, jsUri.fsPath, `${func} 的定义应该在JS文件中`);

            // 在 JS 中查找函数定义
            const jsPosition = findPositionOfVariable(jsDocument, `function ${func}`);
            assert.notStrictEqual(jsPosition, undefined, `未找到函数 ${func} 在JS中的定义`);

            // 检查函数引用
            const references = await vscode.commands.executeCommand<vscode.Location[]>(
                'vscode.executeReferenceProvider',
                jsUri,
                jsPosition!
            );

            assert.ok(references?.length > 0, `应该找到 ${func} 的引用`);
            assert.ok(
                references.some(ref => ref.uri.fsPath === htmlUri.fsPath),
                `${func} 应该在HTML文件中有引用`
            );
        }
    });

    test('跳转变量测试 - ng-repeat', async () => {
        const htmlUri = vscode.Uri.file(path.join(TEST_FILES_PATH, 'temp2.html'));
        const jsUri = vscode.Uri.file(path.join(TEST_FILES_PATH, 'temp2.js'));

        await angularParser.parseFile(htmlUri);

        const htmlDocument = await vscode.workspace.openTextDocument(htmlUri);
        const jsDocument = await vscode.workspace.openTextDocument(jsUri);

        const variablesToTest = ['items', 'item'];

        for (const variable of variablesToTest) {
            // 在 HTML 中查找变量引用
            const htmlPosition = findPositionOfVariable(htmlDocument, variable);
            assert.notStrictEqual(htmlPosition, undefined, `未找到变量 ${variable} 在HTML中的引用`);

            // 检查变量定义
            const definition = await vscode.commands.executeCommand<vscode.Location[]>(
                'vscode.executeDefinitionProvider',
                htmlUri,
                htmlPosition!
            );

            if (variable === 'items') {
                assert.strictEqual(definition?.length, 1, `应该只找到一个 ${variable} 的定义`);
                assert.strictEqual(definition[0].uri.fsPath, jsUri.fsPath, `${variable} 的定义应该在JS文件中`);
            } else {
                // 'item' 是 ng-repeat 中的局部变量，可能没有明确的定义位置
                assert.strictEqual(definition?.length, 0, `${variable} 不应该有明确的定义位置`);
            }

            // 在 JS 中查找变量定义（只对 'items' 进行）
            if (variable === 'items') {
                const jsPosition = findPositionOfVariable(jsDocument, `$scope.${variable}`);
                assert.notStrictEqual(jsPosition, undefined, `未找到变量 ${variable} 在JS中的定义`);

                // 检查变量引用
                const references = await vscode.commands.executeCommand<vscode.Location[]>(
                    'vscode.executeReferenceProvider',
                    jsUri,
                    jsPosition!
                );

                assert.ok(references?.length > 0, `应该找到 ${variable} 的引用`);
                assert.ok(
                    references.some(ref => ref.uri.fsPath === htmlUri.fsPath),
                    `${variable} 应该在HTML文件中有引用`
                );
            }
        }
    });

    test('跳转变量测试 - $scope变量', async () => {
        const htmlUri = vscode.Uri.file(path.join(TEST_FILES_PATH, 'temp2.html'));
        const jsUri = vscode.Uri.file(path.join(TEST_FILES_PATH, 'temp2.js'));

        await angularParser.parseFile(htmlUri);

        const htmlDocument = await vscode.workspace.openTextDocument(htmlUri);
        const jsDocument = await vscode.workspace.openTextDocument(jsUri);

        const variablesToTest = ['scopeVariable', 'anotherScopeVariable'];

        for (const variable of variablesToTest) {
            // 在 HTML 中查找变量引用
            const htmlPosition = findPositionOfVariable(htmlDocument, variable);
            assert.notStrictEqual(htmlPosition, undefined, `未找到变量 ${variable} 在HTML中的引用`);

            // 检查变量定义
            const definition = await vscode.commands.executeCommand<vscode.Location[]>(
                'vscode.executeDefinitionProvider',
                htmlUri,
                htmlPosition!
            );

            assert.strictEqual(definition?.length, 1, `应该只找到一个 ${variable} 的定义`);
            assert.strictEqual(definition[0].uri.fsPath, jsUri.fsPath, `${variable} 的定义应该在JS文件中`);

            // 在 JS 中查找变量定义
            const jsPosition = findPositionOfVariable(jsDocument, `$scope.${variable}`);
            assert.notStrictEqual(jsPosition, undefined, `未找到变量 ${variable} 在JS中的定义`);

            // 检查变量引用
            const references = await vscode.commands.executeCommand<vscode.Location[]>(
                'vscode.executeReferenceProvider',
                jsUri,
                jsPosition!
            );

            assert.ok(references?.length > 0, `应该找到 ${variable} 的引用`);
            assert.ok(
                references.some(ref => ref.uri.fsPath === htmlUri.fsPath),
                `${variable} 应该在HTML文件中有引用`
            );
        }
    });

    // TODO: 如果需要，可以在这里添加更多针对 HTML 文件的测试...
});

function findPositionOfVariable(document: vscode.TextDocument, variable: string): vscode.Position | undefined {
    const text = document.getText();
    const index = text.indexOf(variable);
    if (index !== -1) {
        return document.positionAt(index);
    }
    return undefined;
}
