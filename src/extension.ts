// 'vscode' 模块包含了 VS Code 的扩展性 API
// 导入该模块并在下面的代码中使用别名 vscode 引用它
import * as vscode from 'vscode';
import { AngularParser } from './angularParser';
import { DefinitionProvider } from './definitionProvider';

/** 存储可释放资源的数组 */
let disposables: vscode.Disposable[] = [];
/** Angular 解析器实例 */
let angularParser: AngularParser | undefined;

/**
 * 激活扩展
 * @param {vscode.ExtensionContext} context - 扩展上下文
 */
export async function activate(context: vscode.ExtensionContext) {
	try {
		console.log('正在激活 Angular 助手扩展...');

		angularParser = new AngularParser();
		const definitionProvider = new DefinitionProvider(angularParser);

		disposables.push(
			vscode.languages.registerDefinitionProvider(['html', 'javascript'], definitionProvider),
			vscode.workspace.onDidChangeTextDocument(event => {
				if (['html', 'javascript'].includes(event.document.languageId) && angularParser) {
					angularParser.parseFile(event.document.uri);
				}
			})
		);

		context.subscriptions.push(...disposables);

		await initializeParser();

		context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(handleConfigChange));

		console.log('Angular 助手扩展已成功激活');
	} catch (error) {
		console.error('激活 Angular 助手扩展时出错:', error);
	}
}

/**
 * 处理配置变更
 * @param {vscode.ConfigurationChangeEvent} e - 配置变更事件
 */
async function handleConfigChange(e: vscode.ConfigurationChangeEvent) {
	if (e.affectsConfiguration('angularDefinitionProvider')) {
		console.log('Angular 助手配置已更改，正在重新初始化...');
		angularParser = new AngularParser();
		await initializeParser();
	}
}

/**
 * 初始化解析器
 */
async function initializeParser() {
	try {
		const config = vscode.workspace.getConfiguration('angularDefinitionProvider');
		const excludePatterns = config.get<string[]>('excludePatterns', ['doc/**']);
		const fileUris = await vscode.workspace.findFiles('**/*.{html,js}', `{${excludePatterns.join(',')}}`);
		
		console.log(`开始初始化解析器，共找到 ${fileUris.length} 个文件`);

		// 使用异步生成器函数来逐步处理文件
		for await (const uri of processFilesAsync(fileUris)) {
			await angularParser?.parseFile(uri);
		}

		console.log('解析器初始化完成');
	} catch (error) {
		console.error('初始化解析器时出错:', error);
	}
}

/**
 * 异步生成器函数，用于逐步处理文件
 * @param {vscode.Uri[]} fileUris - 文件 URI 数组
 * @yields {vscode.Uri} 单个文件的 URI
 */
async function* processFilesAsync(fileUris: vscode.Uri[]): AsyncGenerator<vscode.Uri, void, undefined> {
	const batchSize = 10; // 每批处理的文件数量
	for (let i = 0; i < fileUris.length; i += batchSize) {
		const batch = fileUris.slice(i, i + batchSize);
		yield* batch;
		// 在每批处理之后添加一个小延迟，以避免阻塞 UI
		await new Promise(resolve => setTimeout(resolve, 0));
	}
}

/**
 * 停用扩展
 */
export function deactivate() {
	console.log('正在停用 Angular 助手扩展...');
	disposables.forEach(disposable => disposable.dispose());
	disposables = [];

	if (angularParser) {
		angularParser = undefined;
	}

	console.log('Angular 助手扩展已停用');
}
