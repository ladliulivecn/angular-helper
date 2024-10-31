// 'vscode' 模块包含了 VS Code 的扩展性 API
// 导入该模块并在下面的代码中使用别名 vscode 引用它
import * as vscode from 'vscode';
import { AngularParser } from './angularParser';
import { DefinitionProvider } from './definitionProvider';
import { ReferenceProvider } from './referenceProvider';
import { FileUtils } from './utils/FileUtils';

/** 存储可释放资源的数组 */
let disposables: vscode.Disposable[] = [];
/** Angular 解析器实例 */
let angularParser: AngularParser | undefined;
/** 定义提供者实例 */
let definitionProvider: DefinitionProvider | undefined;
/** 输出通道 */
export let outputChannel: vscode.OutputChannel;
/** 初始化锁 */
let isInitializing = false;
/** 取消令牌源 */
let cancelTokenSource: vscode.CancellationTokenSource | undefined;

/**
 * 激活扩展。
 * 这个函数在扩展被激活时被调用。它设置了必要的实例和事件监听器，并初始化了解析器。
 * @param {vscode.ExtensionContext} context - 扩展上下文，提供了访问扩展的各种资源的方法。
 */
export async function activate(context: vscode.ExtensionContext) {
	try {
		outputChannel = vscode.window.createOutputChannel('Angular Helper');		
		outputChannel.show(); // 强制显示输出面板
		FileUtils.initOutputChannel(outputChannel);
		FileUtils.log('正在激活 Angular 助手扩展...');

		angularParser = new AngularParser();
		definitionProvider = new DefinitionProvider(angularParser);
		const referenceProvider = new ReferenceProvider(angularParser);

		registerProviders();

		// 注册 ReferenceProvider
		context.subscriptions.push(
			vscode.languages.registerReferenceProvider(['html', 'javascript'], referenceProvider)
		);

		context.subscriptions.push(...disposables);

		await initializeParser();

		context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(handleConfigChange));



		context.subscriptions.push(
			vscode.window.onDidChangeActiveTextEditor(async (editor) => {
				if (editor && angularParser) {
					try {
						await angularParser.prioritizeCurrentFile(editor.document);
					} catch (error) {
						FileUtils.logError('优先解析当前文件时出错:', error);
					}
				}
			})
		);

		if (vscode.window.activeTextEditor && angularParser) {
			try {
				await angularParser.prioritizeCurrentFile(vscode.window.activeTextEditor.document);
			} catch (error) {
				FileUtils.logError('优先解析当前文件时出错:', error);
			}
		}

		FileUtils.log('Angular 助手扩展已成功激活');		

		// 监听配置变化
		context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('angularHelper') && angularParser) {
				const config = vscode.workspace.getConfiguration('angularHelper');
				angularParser.updateConfiguration(config);
			}
		}));
	} catch (error: unknown) {
		FileUtils.logError('激活 Angular 助手扩展时出错:', error);
		vscode.window.showErrorMessage(`Angular 助手扩展激活失败: ${error instanceof Error ? error.message : '未知错误'}`);
	}
}

/**
 * 注册提供者。
 * 这个函数注册了定义提供者和各种事件监听器。
 */
function registerProviders() {
	disposables.push(
		vscode.languages.registerDefinitionProvider(['html'], definitionProvider!),
		vscode.workspace.onDidChangeTextDocument(async event => {
			if (['html'].includes(event.document.languageId) && angularParser) {
				try {
					await angularParser.updateFileIndex(event.document.uri);
				} catch (error) {
					FileUtils.logError(`更新文件索引时出错 ${event.document.uri.fsPath}:`, error);
				}
			}
		}),
		vscode.workspace.onDidOpenTextDocument(async document => {
			if (['html'].includes(document.languageId) && angularParser) {
				FileUtils.log(`优先解析新打开的文件: ${document.fileName}`);
				try {
					await angularParser.updateFileIndex(document.uri);
				} catch (error) {
					FileUtils.logError(`更新新打开文件的索引时出错 ${document.fileName}:`, error);
				}
			}
		})
	);
}

/**
 * 处理配置变更。
 * 当扩展的配置发生变化时，这个函会被调用。它会重新初始化解析器和提供者。
 * @param {vscode.ConfigurationChangeEvent} e - 配置变更事件，包含了哪些配置发生了变化的信息。
 */
async function handleConfigChange(e: vscode.ConfigurationChangeEvent) {
	if (e.affectsConfiguration('angularDefinitionProvider') || e.affectsConfiguration('angularHelper')) {
		FileUtils.log('Angular 助手配置已更改，正在重新初始化...');
		
		// 如果正在初始化，取消当前的初始化过程
		if (isInitializing && cancelTokenSource) {
			cancelTokenSource.cancel();
			cancelTokenSource = undefined;
			await waitForInitializationToStop();
		}

		// 清除旧的 disposables
		disposables.forEach(d => d.dispose());
		disposables = [];

		// 重新创建 AngularParser、DefinitionProvider 和 ReferenceProvider
		angularParser = new AngularParser();
		definitionProvider = new DefinitionProvider(angularParser);
		const referenceProvider = new ReferenceProvider(angularParser);

		// 重新注册 providers
		registerProviders();

		// 重新注册 ReferenceProvider
		disposables.push(
			vscode.languages.registerReferenceProvider(['html', 'javascript'], referenceProvider)
		);

		// 重新初始化解析器
		await initializeParser();
	}
}

/**
 * 等待初始化停止。
 * 这个函数会一直等待，直到初始化过程结束。
 * @returns {Promise<void>} 当初始化停止时解决的 Promise。
 */
async function waitForInitializationToStop(): Promise<void> {
	while (isInitializing) {
		await new Promise(resolve => setTimeout(resolve, 100));
	}
}

/**
 * 初始化解析器。
 * 这个函数负责初始化 Angular 解析器。它会找到所有的 HTML 和 JS 文件，
 * 并将它们传递给解析器进行处理。
 */
async function initializeParser() {
	if (isInitializing) {
		FileUtils.log('解析器正在初始化中，取消当前初始化并重新开始');
		if (cancelTokenSource) {
			cancelTokenSource.cancel();
			cancelTokenSource = undefined;
			await waitForInitializationToStop();
		}
	}

	isInitializing = true;
	cancelTokenSource = new vscode.CancellationTokenSource();

	try {
		const config = vscode.workspace.getConfiguration('angularHelper');
		const ignorePatterns = config.get<string[]>('ignorePatterns') || [];
		const fileUris = await vscode.workspace.findFiles('**/*.{html}', `{${ignorePatterns.join(',')}}`, undefined, cancelTokenSource.token);
		
		FileUtils.log(`开始初始化解析器，共找到 ${fileUris.length} 个文件`);

		if (angularParser) {
			await angularParser.initializeParser(fileUris, cancelTokenSource.token);
		} else {
			FileUtils.log('错误：Angular 解析器未初始化');
		}

		FileUtils.log('解析器初始化完成');
	} catch (error) {
		if (error instanceof vscode.CancellationError) {
			FileUtils.log('解析器初始化被取消');
		} else {
			FileUtils.logError('初始化解析器时出错:', error);
		}
	} finally {
		isInitializing = false;
		cancelTokenSource = undefined;
	}
}

/**
 * 停用扩展。
 * 这个函数在扩展被停用时被调用。它会清理所有的资源。
 */
export function deactivate() {
	FileUtils.log('正在停用 Angular 助手扩展...');
	disposables.forEach(disposable => disposable.dispose());
	disposables = [];

	if (angularParser) {
		angularParser = undefined;
	}

	FileUtils.log('Angular 助手扩展已停用');
}



/**
 * 设置输出通道。
 * 这个函数用于设置扩展的输出通道。
 * @param {vscode.OutputChannel} channel - 要设置的输出通道。
 */
export function setOutputChannel(channel: vscode.OutputChannel) {
	outputChannel = channel;
}
