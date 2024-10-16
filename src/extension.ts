// 'vscode' 模块包含了 VS Code 的扩展性 API
// 导入该模块并在下面的代码中使用别名 vscode 引用它
import * as vscode from 'vscode';
import { AngularParser } from './angularParser';
import { DefinitionProvider } from './definitionProvider';

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

		log('正在激活 Angular 助手扩展...');

		angularParser = new AngularParser();
		definitionProvider = new DefinitionProvider(angularParser);

		registerProviders();

		context.subscriptions.push(...disposables);

		await initializeParser();

		context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(handleConfigChange));

		context.subscriptions.push(
			vscode.commands.registerCommand('angularHelper.outputPerformanceReport', () => {
				definitionProvider?.outputPerformanceReport();
			})
		);

		context.subscriptions.push(
			vscode.window.onDidChangeActiveTextEditor(async (editor) => {
				if (editor && angularParser) {
					try {
						await angularParser.prioritizeCurrentFile(editor.document);
					} catch (error) {
						logError('优先解析当前文件时出错:', error);
					}
				}
			})
		);

		if (vscode.window.activeTextEditor && angularParser) {
			try {
				await angularParser.prioritizeCurrentFile(vscode.window.activeTextEditor.document);
			} catch (error) {
				logError('优先解析当前文件时出错:', error);
			}
		}

		log('Angular 助手扩展已成功激活');
	} catch (error: unknown) {
		logError('激活 Angular 助手扩展时出错:', error);
		vscode.window.showErrorMessage(`Angular 助手扩展激活失败: ${error instanceof Error ? error.message : '未知错误'}`);
	}
}

/**
 * 注册提供者。
 * 这个函数注册了定义提供者和各种事件监听器。
 */
function registerProviders() {
	disposables.push(
		vscode.languages.registerDefinitionProvider(['html', 'javascript'], definitionProvider!),
		vscode.workspace.onDidChangeTextDocument(async event => {
			if (['html', 'javascript'].includes(event.document.languageId) && angularParser) {
				try {
					await angularParser.updateFileIndex(event.document.uri);
				} catch (error) {
					logError(`更新文件索引时出错 ${event.document.uri.fsPath}:`, error);
				}
			}
		}),
		vscode.workspace.onDidOpenTextDocument(async document => {
			if (['html', 'javascript'].includes(document.languageId) && angularParser) {
				log(`优先解析新打开的文件: ${document.fileName}`);
				try {
					await angularParser.updateFileIndex(document.uri);
				} catch (error) {
					logError(`更新新打开文件的索引时出错 ${document.fileName}:`, error);
				}
			}
		})
	);
}

/**
 * 处理配置变更。
 * 当扩展的配置发生变化时，这个函数会被调用。它会重新初始化解析器和提供者。
 * @param {vscode.ConfigurationChangeEvent} e - 配置变更事件，包含了哪些配置发生了变化的信息。
 */
async function handleConfigChange(e: vscode.ConfigurationChangeEvent) {
	if (e.affectsConfiguration('angularDefinitionProvider') || e.affectsConfiguration('angularHelper')) {
		log('Angular 助手配置已更改，正在重新初始化...');
		
		// 如果正在初始化，取消当前的初始化过程
		if (isInitializing && cancelTokenSource) {
			cancelTokenSource.cancel();
			cancelTokenSource = undefined;
			await waitForInitializationToStop();
		}

		// 清除旧的 disposables
		disposables.forEach(d => d.dispose());
		disposables = [];

		// 重新创建 AngularParser 和 DefinitionProvider
		angularParser = new AngularParser();
		definitionProvider = new DefinitionProvider(angularParser);

		// 重新注册 providers
		registerProviders();

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
		log('解析器正在初始化中，取消当前初始化并重新开始');
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
		const fileUris = await vscode.workspace.findFiles('**/*.{html,js}', `{${ignorePatterns.join(',')}}`, undefined, cancelTokenSource.token);
		
		log(`开始初始化解析器，共找到 ${fileUris.length} 个文件`);

		if (angularParser) {
			await angularParser.initializeParser(fileUris, cancelTokenSource.token);
		} else {
			log('错误：Angular 解析器未初始化');
		}

		log('解析器初始化完成');
	} catch (error) {
		if (error instanceof vscode.CancellationError) {
			log('解析器初始化被取消');
		} else {
			logError('初始化解析器时出错:', error);
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
	log('正在停用 Angular 助手扩展...');
	disposables.forEach(disposable => disposable.dispose());
	disposables = [];

	if (angularParser) {
		angularParser = undefined;
	}

	log('Angular 助手扩展已停用');
}

/**
 * 记录日志。
 * 这个函数用于记录普通日志信息。
 * @param {string} message - 要记录的日志消息。
 */
export function log(message: string) {
	if (vscode.workspace.getConfiguration('angularHelper').get<boolean>('enableLogging', true)) {
		if (outputChannel) {
			outputChannel.appendLine(`[${new Date().toLocaleString()}] ${message}`);
		} else {
			console.log(message); // 在测试环境中使用控制台日志
		}
	}
}

/**
 * 记录错误日志。
 * 这个函数用于记录错误日志信息。
 * @param {string} message - 错误消息。
 * @param {unknown} error - 错误对象。
 */
export function logError(message: string, error: unknown): void {
	if (vscode.workspace.getConfiguration('angularHelper').get<boolean>('enableLogging', true)) {
		const errorMessage = error instanceof Error ? error.stack || error.message : String(error);
		if (outputChannel) {
			outputChannel.appendLine(`[${new Date().toLocaleString()}] ERROR: ${message}\n${errorMessage}`);	
		} else {
			console.error(`ERROR: ${message}`, error); // 在测试环境中使用控制台错误日志
		}
	}
}

/**
 * 设置输出通道。
 * 这个函数用于设置扩展的输出通道。
 * @param {vscode.OutputChannel} channel - 要设置的输出通道。
 */
export function setOutputChannel(channel: vscode.OutputChannel) {
	outputChannel = channel;
}
