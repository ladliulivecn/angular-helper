import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import { AngularParser } from '../angularParser';
import { DefinitionProvider } from '../definitionProvider';
import { setOutputChannel } from '../extension';
import { ReferenceProvider } from '../referenceProvider';
import { FileUtils } from '../utils/FileUtils';

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
    });

    test('HTML 解析 - Script 标签和 ng-* 属性', async () => {
        const testFilePath = path.join(TEST_FILES_PATH, 'temp1.html');
        const uri = vscode.Uri.file(testFilePath);
        await angularParser.parseFile(uri);
        const fileInfo = angularParser.getFileInfo(testFilePath);

        assert.ok(fileInfo, 'fileInfo 应该存在');
        assert.ok(fileInfo.ngAttributes, 'ngAttributes 应该存在');
        assert.strictEqual(fileInfo.ngAttributes.size > 0, true, 'ngAttributes 不应为空');
        
        // 检查内联script中定义的Angular应用和控制器
        assert.ok(fileInfo.ngAttributes.has('app'), '应包含 ng-app');
        assert.ok(fileInfo.ngAttributes.has('controller'), '应包含 ng-controller');        
        assert.ok(fileInfo.ngAttributes.has('click'), '应包含 ng-click');
    });

    test('函数定义和引用测试', async () => {
        const htmlUri = vscode.Uri.file(path.join(TEST_FILES_PATH, 'temp1.html'));
        
        FileUtils.log(`解析 HTML 文件: ${htmlUri.fsPath}`);
        await angularParser.parseFile(htmlUri);

        const htmlDocument = await vscode.workspace.openTextDocument(htmlUri);
        const htmlFileInfo = angularParser.getFileInfo(htmlUri.fsPath);
        
        assert.ok(htmlFileInfo, 'HTML 文件信息应该存在');
        
        // 测试内联script中定义的函数
        const functionsToTest = ['ConfirmGroup', 'AddGroup', 'SubmitGroups', 'DelGroup', 'ClickOper'];

        for (const func of functionsToTest) {
            FileUtils.log(`测试函数: ${func}`);
            
            const htmlFunction = htmlFileInfo.functions.get(func) ? htmlFileInfo.functions.get(func)![0] : undefined;
            assert.ok(htmlFunction, `应该找到函数 ${func} 的引用`);

            // 检查函数定义
            if (htmlFunction.isDefinition) {
                const definitionPosition = angularParser.getPositionLocation(htmlUri.fsPath, htmlFunction.position);
                FileUtils.log(`找到函数 ${func} 的定义`);
                FileUtils.log(`定义位置: ${htmlUri.fsPath}, 行 ${definitionPosition.line + 1}, 列 ${definitionPosition.character + 1}`);

                const foundDefinition = await definitionProvider.provideDefinition(htmlDocument, definitionPosition);
                assert.notStrictEqual(foundDefinition, undefined, `应该找到 ${func} 的定义`);
                assert.ok(foundDefinition instanceof vscode.Location, `${func} 的定义应该是 Location 类型`);
            }

            // 测试引用查找
            const referencePosition = angularParser.getPositionLocation(htmlUri.fsPath, htmlFunction.position);
            const references = await referenceProvider.provideReferences(htmlDocument, referencePosition);

            if (references && references.length > 0) {
                FileUtils.log(`函数 ${func} 的所有引用:`);
                references.forEach((ref: vscode.Location, index: number) => {
                    FileUtils.log(`  引用 ${index + 1}: 文件 ${ref.uri.fsPath}, 行 ${ref.range.start.line + 1}, 列 ${ref.range.start.character + 1}`);
                });
                
                assert.ok(references.some((ref: vscode.Location) => ref.uri.fsPath === htmlUri.fsPath),
                    `${func} 应该在HTML文件中有引用`);
            }
        }
    });

    test('变量定义和引用测试', async () => {
        const htmlUri = vscode.Uri.file(path.join(TEST_FILES_PATH, 'temp1.html'));
        await angularParser.parseFile(htmlUri);

        const htmlDocument = await vscode.workspace.openTextDocument(htmlUri);
        const htmlFileInfo = angularParser.getFileInfo(htmlUri.fsPath);
        
        assert.ok(htmlFileInfo, 'HTML 文件信息应该存在');

        // 测试内联script中定义的变量
        const variablesToTest = ['costLists', 'groups', 'hdinfo', 'errmsg'];
        const htmlContent = htmlDocument.getText();

        for (const varName of variablesToTest) {
            FileUtils.log(`测试变量: ${varName}`);

            // 检查变量定义
            const scopeVariable = htmlFileInfo.scopeVariables.get(varName);
            assert.ok(scopeVariable, `${varName} 变量应该在 scopeVariables 中有定义`);
            assert.ok(scopeVariable.isDefinition, `${varName} 应该被标记为定义`);

            // 检查变量引用
            const functionRefs = htmlFileInfo.functions.get(varName) || [];
            assert.ok(functionRefs.some(ref => !ref.isDefinition), 
                `${varName} 变量应该有引用`);

            // 输出日志
            FileUtils.log(`${varName} 变量定义位置: 行 ${
                angularParser.getPositionLocation(htmlUri.fsPath, scopeVariable.position).line + 1
            }`);
            FileUtils.log(`${varName} 变量引用数量: ${functionRefs.length}`);

            // 检查变量在HTML中的使用
            assert.ok(htmlContent.includes(`$scope.${varName}`), 
                `HTML文件中应该包含 $scope.${varName}`);

            FileUtils.log(`${varName} 变量测试完成`);
        }
    });

    test('Angular Filter 解析测试', async () => {
        const htmlUri = vscode.Uri.file(path.join(TEST_FILES_PATH, 'temp1.html'));
        await angularParser.parseFile(htmlUri);
        
        const htmlFileInfo = angularParser.getFileInfo(htmlUri.fsPath);
        assert.ok(htmlFileInfo, 'HTML 文件信息应该存在');

        // 检查内联script中定义的filters
        assert.ok(htmlFileInfo.filters.has('filterCompType'), '应该找到 filterCompType filter 的定义');
        assert.ok(htmlFileInfo.filters.has('filterFormatDate'), '应该找到 filterFormatDate filter 的定义');
        assert.ok(htmlFileInfo.filters.has('filterFix'), '应该找到 filterFix filter 的定义');
        
        // 检查filter定义和引用
        const compTypeFilter = htmlFileInfo.filters.get('filterCompType');
        assert.ok(compTypeFilter && compTypeFilter.length > 0, 'filterCompType filter 信息应该存在');
        
        // 找到定义
        const filterDef = compTypeFilter!.find(f => f.isDefinition);
        assert.ok(filterDef, 'filterCompType filter 应该有一个定义');

        // 检查filter引用
        const filterRefs = htmlFileInfo.filters.get('filterCompType');
        assert.ok(filterRefs && filterRefs.length > 0, 'filterCompType filter 应该有引用');

        // 检查位置信息
        const filterDefPosition = angularParser.getPositionLocation(htmlUri.fsPath, filterDef.position);
        FileUtils.log(`Filter 定义位置: 行 ${filterDefPosition.line + 1}, 列 ${filterDefPosition.character + 1}`);

        FileUtils.log(`Filter 总共数量: ${htmlFileInfo.filters.size}`);
    });

    // TODO: 如果需要，可以在这里添加更多针对 HTML 文件的测试...
});
