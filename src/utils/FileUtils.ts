import * as vscode from 'vscode';

export class FileUtils {
    private static outputChannel: vscode.OutputChannel | undefined;
    public static initOutputChannel(outputChannel: vscode.OutputChannel): void {
        this.outputChannel = outputChannel;
    }
    /**
     * 记录普通日志信息
     * @param message 日志消息
     */
    public static log(message: string): void {
        if (vscode.workspace.getConfiguration('angularHelper').get<boolean>('enableLogging', true)) {
            if (this.outputChannel) {
                this.outputChannel.appendLine(`[${new Date().toLocaleString()}] ${message}`);
            }
            console.log(`[AngularHelper] ${message}`);
        }
    }

    /**
     * 记录错误日志信息
     * @param message 错误消息
     * @param error 错误对象
     */
    public static logError(message: string, error: unknown): void {
        if (vscode.workspace.getConfiguration('angularHelper').get<boolean>('enableLogging', true)) {
            const errorMessage = error instanceof Error ? error.stack || error.message : String(error);
            if (this.outputChannel) {
                this.outputChannel.appendLine(`[${new Date().toLocaleString()}] ERROR: ${message}\n${errorMessage}`);
            }
            console.error(`[AngularHelper] ERROR: ${message}`, error);
        }
    }
    /**
     * 检查文件是否存在
     * @param fileUri 文件 URI
     * @returns 文件是否存在
     */
    public static async fileExists(fileUri: vscode.Uri): Promise<boolean> {
        try {
            await vscode.workspace.fs.stat(fileUri);
            return true;
        } catch {
            return false;
        }
    }
    // 增加一个调试日志的方法用于关联文件日志调试
    public static logDebugForAssociations(message: string): void {
        if (vscode.workspace.getConfiguration('angularHelper').get<boolean>('debugAssociations')) {
            this.log(`[关联文件] ${message}`);
        }
    }
    // 增加一个调试日志的方法用于查找定义和引用逻辑的日志调试
    public static logDebugForFindDefinitionAndReference(message: string): void {
        if (vscode.workspace.getConfiguration('angularHelper').get<boolean>('debugFindDefinitionAndReference')) {
            this.log(`[查找定义和引用] ${message}`);
        }
    }
}
