/* eslint-disable curly */
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { FileAssociationManager } from './managers/FileAssociationManager';
import { FileInfoManager } from './managers/FileInfoManager';
import { HtmlParser } from './parsers/HtmlParser';
import { JavaScriptParser } from './parsers/JavaScriptParser';
import { ParserBase } from './parsers/ParserBase';
import { FileInfo, SUPPORTED_LANGUAGES } from './types/types';
import { FileUtils } from './utils/FileUtils';
import { PathResolver } from './utils/PathResolver';

// 文件处理任务类型
interface FileTask {
    uri: vscode.Uri;
    priority: number;
    fullParse: boolean;
}

/**
 * Angular 解析器类
 * 这个类负责解析 Angular 项目中的文件，建立文件之间的关联，
 * 并提供查找定义的功能。
 */
export class AngularParser extends ParserBase {
    private fileInfoManager: FileInfoManager;
    private fileAssociationManager: FileAssociationManager;
    private jsParser: JavaScriptParser;
    private htmlParser: HtmlParser;
    private pathResolver: PathResolver;
    private parseQueue: vscode.Uri[] = [];
    private isParsingQueue = false;
    private maxConcurrentParsing: number;
    private readonly DEFAULT_BATCH_SIZE = 5;

    // 文件解析状态缓存
    private fileParsePromises = new Map<string, Promise<void>>();
    private readonly FILE_PARSE_TIMEOUT = 30000; // 30秒超时

    // 优先级常量
    private readonly HIGH_PRIORITY = 1;
    private readonly NORMAL_PRIORITY = 2;
    private readonly LOW_PRIORITY = 3;

    // 文件处理队列
    private fileQueue: FileTask[] = [];
    private isProcessingQueue = false;
    private visibleFiles = new Set<string>();

    constructor() {
        super();
        const config = vscode.workspace.getConfiguration('angularHelper');
        this.pathResolver = new PathResolver(config);
        this.fileInfoManager = new FileInfoManager(config);
        this.htmlParser = new HtmlParser(this.pathResolver);
        this.jsParser = new JavaScriptParser();
        this.fileAssociationManager = new FileAssociationManager(this.htmlParser, this.jsParser, this.fileInfoManager);
        this.maxConcurrentParsing = config.get<number>('maxConcurrentParsing') || this.DEFAULT_BATCH_SIZE;
    }

    /**
     * 设置模拟的工作区路径（用于测试）
     * @param mockPath 模拟的工作区路径
     */
    public setMockWorkspacePath(mockPath: string | null): void {
        this.pathResolver.setMockWorkspacePath(mockPath);
    }

    public async initializeParser(files: vscode.Uri[], token: vscode.CancellationToken): Promise<void> {
        FileUtils.log(`开始初始化解析器，传入的文件数量: ${files.length}`);

        const filteredFiles = files.filter(file => !this.pathResolver.shouldIgnore(file.fsPath));
        FileUtils.log(`过滤后的文件数量: ${filteredFiles.length}`);

        // 先构建文件关联
        await this.fileAssociationManager.buildFileAssociations(filteredFiles, token);

        // 优先解析当前打开的文件
        const openFiles = vscode.workspace.textDocuments
            .filter(doc => doc.uri.scheme === 'file')
            .map(doc => doc.uri);

        // 将打开的文件移到队列前面
        this.parseQueue = [
            ...openFiles,
            ...filteredFiles.filter(file => !openFiles.some(open => open.fsPath === file.fsPath))
        ];

        await this.processQueue(token);
    }

    private async processQueue(token: vscode.CancellationToken): Promise<void> {
        if (this.isParsingQueue) return;
        this.isParsingQueue = true;

        try {
            while (this.parseQueue.length > 0) {
                if (token.isCancellationRequested) {
                    throw new vscode.CancellationError();
                }

                // 获取下一批要解析的文件
                const batch = this.parseQueue.splice(0, this.maxConcurrentParsing);

                // 并行解析文件，但限制并发数
                const batchPromises = batch.map(file => this.parseFileWithTimeout(file));
                await Promise.all(batchPromises);
            }
        } catch (error) {
            if (error instanceof vscode.CancellationError) {
                FileUtils.log('解析队列处理被取消');
            } else {
                FileUtils.logError('处理解析队列时出错:', error);
            }
        } finally {
            this.isParsingQueue = false;
        }
    }

    private async parseFileWithTimeout(file: vscode.Uri): Promise<void> {
        const filePath = file.fsPath;

        // 如果文件已经在解析中，返回现有的 Promise
        if (this.fileParsePromises.has(filePath)) {
            return this.fileParsePromises.get(filePath)!;
        }

        // 创建一个带超时的解析 Promise
        const parsePromise = new Promise<void>(async (resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error(`解析文件超时: ${filePath}`));
            }, this.FILE_PARSE_TIMEOUT);

            try {
                await this.parseFile(file);
                clearTimeout(timeout);
                resolve();
            } catch (error) {
                clearTimeout(timeout);
                reject(error);
            } finally {
                this.fileParsePromises.delete(filePath);
            }
        });

        // 存储 Promise 以便重用
        this.fileParsePromises.set(filePath, parsePromise);
        return parsePromise;
    }

    private async shouldUseCache(file: vscode.Uri, fileInfo: FileInfo): Promise<boolean> {
        try {
            const stat = await vscode.workspace.fs.stat(file);
            const cachedStat = await vscode.workspace.fs.stat(vscode.Uri.file(fileInfo.filePath));

            // 检查文件修改时间和大小
            return stat.mtime === cachedStat.mtime && stat.size === cachedStat.size;
        } catch (error) {
            FileUtils.logError(`检查文件缓存状态失败: ${file.fsPath}`, error);
            return false;
        }
    }

    public async parseFile(file: vscode.Uri, force = false): Promise<void> {
        const filePath = file.fsPath;

        // 如果文件正在解析中，等待解析完成
        if (this.fileParsePromises.has(filePath)) {
            FileUtils.log(`等待文件解析完成: ${filePath}`);
            return this.fileParsePromises.get(filePath);
        }

        // 检查文件是否已经被解析过且未修改
        const fileInfo = this.fileInfoManager.getFileInfo(filePath);
        if (!force && fileInfo && await this.shouldUseCache(file, fileInfo)) {
            FileUtils.logDebugForAssociations(`使用缓存的文件解析结果: ${filePath}`);
            return;
        }

        // 检查文件是否在可见编辑器中或是可见文件的关联文件
        const visibleFiles = vscode.window.visibleTextEditors.map(editor => editor.document.uri.fsPath);
        const isVisible = visibleFiles.includes(filePath);

        if (!isVisible && !force) {
            // 检查是否是可见文件的关联文件
            const isAssociatedFile = visibleFiles.some(visibleFile => {
                const ext = path.extname(visibleFile).toLowerCase();
                if (ext === '.html') {
                    return this.getAssociatedJsFiles(visibleFile).includes(filePath);
                } else if (ext === '.js') {
                    return this.getAssociatedHtmlFiles(visibleFile).includes(filePath);
                }
                return false;
            });

            if (!isAssociatedFile) {
                FileUtils.logDebugForFindDefinitionAndReference(`跳过不可见且非关联文件解析: ${filePath}`);
                return;
            }
        }

        try {
            const document = await vscode.workspace.openTextDocument(file);

            if (document.languageId === SUPPORTED_LANGUAGES.JAVASCRIPT) {
                await this.parseJavaScriptFile(document);
            } else if (document.languageId === SUPPORTED_LANGUAGES.HTML) {
                await this.parseHtmlFile(document);
            }
        } catch (error) {
            FileUtils.logError(`解析文件失败: ${filePath}`, error);
            throw error;
        }
    }

    private async parseJavaScriptFile(document: vscode.TextDocument): Promise<void> {
        const filePath = document.uri.fsPath;
        try {
            const fileInfo = await this.jsParser.parseJavaScriptFile(document);
            this.fileInfoManager.setFileInfo(filePath, fileInfo);

            // 更新关联的 HTML 文件
            const htmlFiles = this.fileAssociationManager.getAssociatedHtmlFiles(filePath);
            await this.updateAssociatedFiles(htmlFiles);
        } catch (error) {
            FileUtils.logError(`解析 JavaScript 文件失败: ${filePath}`, error);
            throw error;
        }
    }

    private async parseHtmlFile(document: vscode.TextDocument): Promise<void> {
        const filePath = document.uri.fsPath;
        try {
            const { fileInfo, associatedJsFiles } = await this.htmlParser.parseHtmlFile(document);
            this.fileInfoManager.setFileInfo(filePath, fileInfo);

            // 更新文件关联
            this.fileAssociationManager.clearAssociationsForFile(filePath);
            this.fileAssociationManager.setAssociation(filePath, associatedJsFiles);

            // 更新关联的 JS 文件
            await this.updateAssociatedFiles(associatedJsFiles);
        } catch (error) {
            FileUtils.logError(`解析 HTML 文件失败: ${filePath}`, error);
            throw error;
        }
    }

    private async updateAssociatedFiles(files: string[]): Promise<void> {
        const promises = files
            .filter(file => !this.fileParsePromises.has(file))
            .map(file => this.parseFileWithTimeout(vscode.Uri.file(file)));

        await Promise.all(promises);
    }

    public async prioritizeCurrentFile(document: vscode.TextDocument): Promise<void> {
        if (['html', 'javascript'].includes(document.languageId)) {
            // 更新可见文件列表
            this.updateVisibleFiles();

            // 将当前文件添加到队列中，使用高优先级
            await this.queueFileForProcessing(document.uri, this.HIGH_PRIORITY, true);

            // 将关联文件添加到队列中，使用正常优先级
            if (document.languageId === SUPPORTED_LANGUAGES.HTML) {
                const jsFiles = this.fileAssociationManager.getAssociatedJsFiles(document.fileName);
                for (const jsFile of jsFiles) {
                    await this.queueFileForProcessing(vscode.Uri.file(jsFile), this.NORMAL_PRIORITY, true);
                }
            } else if (document.languageId === SUPPORTED_LANGUAGES.JAVASCRIPT) {
                const htmlFiles = this.fileAssociationManager.getAssociatedHtmlFiles(document.fileName);
                for (const htmlFile of htmlFiles) {
                    await this.queueFileForProcessing(vscode.Uri.file(htmlFile), this.NORMAL_PRIORITY, true);
                }
            }
        }
    }

    public async updateFileIndex(fileUri: vscode.Uri, fullParse = false): Promise<void> {
        const absolutePath = fileUri.fsPath;
        const fileExtension = path.extname(absolutePath).toLowerCase();

        try {
            if (!await FileUtils.fileExists(fileUri)) {
                return;
            }

            // 快速建立关联关系
            if (fileExtension === '.html') {
                await this.quickUpdateHtmlAssociations(fileUri);
            } else if (fileExtension === '.js') {
                await this.quickUpdateJsAssociations(fileUri);
            } else {
                throw new Error(`不支持的文件类型: ${fileExtension}, 文件: ${absolutePath}`);
            }

            // 仅在需要时进行完整解析
            if (fullParse) {
                if (fileExtension === '.html') {
                    await this.updateHtmlFileIndex(fileUri);
                } else if (fileExtension === '.js') {
                    await this.updateJsFileIndex(fileUri);
                }
            }

            FileUtils.logDebugForAssociations(`文件索引更新完成: ${absolutePath}`);
        } catch (error) {
            FileUtils.logError(`更新文件索引时出错 ${absolutePath}:`, error);
            throw error;
        }
    }

    private async quickUpdateHtmlAssociations(fileUri: vscode.Uri): Promise<void> {
        const filePath = fileUri.fsPath;
        try {
            const document = await vscode.workspace.openTextDocument(fileUri);
            const { associatedJsFiles } = await this.htmlParser.parseHtmlFileAssociations(document);
            this.fileAssociationManager.clearAssociationsForFile(filePath);
            this.fileAssociationManager.setAssociation(filePath, associatedJsFiles);
        } catch (error) {
            FileUtils.logError(`快速更新HTML关联时出错 ${filePath}:`, error);
            throw error;
        }
    }

    private async quickUpdateJsAssociations(fileUri: vscode.Uri): Promise<void> {
        const filePath = fileUri.fsPath;
        try {
            const document = await vscode.workspace.openTextDocument(fileUri);
            const { associatedHtmlFiles } = await this.jsParser.parseJavaScriptFileAssociations(document);
            this.fileAssociationManager.clearAssociationsForFile(filePath);
            this.fileAssociationManager.setAssociation(filePath, associatedHtmlFiles);
        } catch (error) {
            FileUtils.logError(`快速更新JS关联时出错 ${filePath}:`, error);
            throw error;
        }
    }

    private async updateHtmlFileIndex(fileUri: vscode.Uri): Promise<void> {
        const filePath = fileUri.fsPath;
        try {
            const document = await vscode.workspace.openTextDocument(fileUri);
            const { fileInfo, associatedJsFiles } = await this.htmlParser.parseHtmlFile(document);
            this.fileInfoManager.setFileInfo(filePath, fileInfo);

            // 更新文件关联
            this.fileAssociationManager.clearAssociationsForFile(filePath);
            this.fileAssociationManager.setAssociation(filePath, associatedJsFiles);

            await this.updateAssociatedFiles(associatedJsFiles);
        } catch (error) {
            FileUtils.logError(`更新HTML文件索引时出错 ${filePath}:`, error);
            throw error;
        }
    }

    private async updateJsFileIndex(fileUri: vscode.Uri): Promise<void> {
        const filePath = fileUri.fsPath;
        try {
            const document = await vscode.workspace.openTextDocument(fileUri);
            const fileInfo = await this.jsParser.parseJavaScriptFile(document);
            this.fileInfoManager.setFileInfo(filePath, fileInfo);
        } catch (error) {
            FileUtils.logError(`更新JavaScript文件索引时出错 ${filePath}:`, error);
            throw error;
        }
    }

    public getFileInfo(filePath: string): FileInfo | undefined {
        return this.fileInfoManager.getFileInfo(filePath);
    }
    public getPositionLocation(filePath: string, position: number): vscode.Position {
        const content = this.getFileContent(filePath);
        if (!content) return new vscode.Position(0, 0);

        const lines = content.split('\n');
        let currentPosition = 0;
        for (let i = 0; i < lines.length; i++) {
            currentPosition += lines[i].length + 1; // +1 for the newline character
            if (currentPosition > position) {
                return new vscode.Position(i, position - (currentPosition - lines[i].length - 1));
            }
        }
        return new vscode.Position(lines.length - 1, 0);
    }
    private getFileContent(filePath: string): string | undefined {
        try {
            return fs.readFileSync(filePath, 'utf8');
        } catch (error) {
            FileUtils.logError(`读取文件内容时出错 ${filePath}:`, error);
            return undefined;
        }
    }

    public getAssociatedJsFiles(htmlFilePath: string): string[] {
        return this.fileAssociationManager.getAssociatedJsFiles(htmlFilePath);
    }

    public getAssociatedHtmlFiles(jsFilePath: string): string[] {
        return this.fileAssociationManager.getAssociatedHtmlFiles(jsFilePath);
    }

    public getFirstFunctionInfo(fileInfo: FileInfo, functionName: string): vscode.Location | undefined {
        const functionInfos = fileInfo.functions.get(functionName);
        if (functionInfos && functionInfos.length > 0) {
            const firstFunction = functionInfos[0];
            return new vscode.Location(
                vscode.Uri.file(fileInfo.filePath),
                this.getPositionLocation(fileInfo.filePath, firstFunction.position)
            );
        }
        return undefined;
    }

    public getAllParsedFiles(): string[] {
        return this.fileInfoManager.getAllParsedFiles();
    }

    public updateConfiguration(config: vscode.WorkspaceConfiguration): void {
        this.maxConcurrentParsing = config.get<number>('maxConcurrentParsing') || this.DEFAULT_BATCH_SIZE;
        this.pathResolver.updateConfiguration(config);
        this.fileInfoManager.updateConfiguration(config);
        // 如果 JavaScriptParser 需要配置更新，也可以在这里添加
        // this.jsParser.updateConfiguration(config);
    }

    /**
     * 清除文件的关联关系
     * @param filePath 要清除关联关系的文件路径
     */
    public clearFileAssociations(filePath: string): void {
        FileUtils.logDebugForAssociations(`清除文件关联关系: ${filePath}`);

        try {
            // 清除文件关联
            this.fileAssociationManager.clearAssociationsForFile(filePath);

            // 清除文件信息
            this.fileInfoManager.removeFileInfo(filePath);

            FileUtils.logDebugForAssociations(`文件关联关系清除完成: ${filePath}`);
        } catch (error) {
            FileUtils.logError(`清除文件关联关系时出错: ${filePath}`, error);
        }
    }

    /**
     * 将文件添加到处理队列中
     * @param uri 文件URI
     * @param priority 优先级（1=高，2=中，3=低）
     * @param fullParse 是否进行完整解析
     */
    public async queueFileForProcessing(uri: vscode.Uri, priority: number, fullParse: boolean): Promise<void> {
        // 检查队列中是否已有此文件
        const existingIndex = this.fileQueue.findIndex(item => item.uri.fsPath === uri.fsPath);

        if (existingIndex >= 0) {
            // 如果已存在，更新优先级为最高的
            this.fileQueue[existingIndex].priority = Math.min(this.fileQueue[existingIndex].priority, priority);
            this.fileQueue[existingIndex].fullParse = this.fileQueue[existingIndex].fullParse || fullParse;
            FileUtils.logDebugForAssociations(`更新队列中的文件: ${uri.fsPath}, 优先级: ${this.fileQueue[existingIndex].priority}`);
        } else {
            // 否则添加到队列
            this.fileQueue.push({ uri, priority, fullParse });
            FileUtils.logDebugForAssociations(`添加文件到队列: ${uri.fsPath}, 优先级: ${priority}`);
        }

        // 如果队列未在处理中，开始处理
        if (!this.isProcessingQueue) {
            await this.processFileQueue();
        }
    }

    /**
     * 处理文件队列
     */
    private async processFileQueue(): Promise<void> {
        if (this.fileQueue.length === 0) {
            this.isProcessingQueue = false;
            return;
        }

        this.isProcessingQueue = true;

        try {
            // 按优先级排序
            this.fileQueue.sort((a, b) => a.priority - b.priority);

            // 取出一批文件（最多 maxConcurrentParsing 个）
            const batch = this.fileQueue.splice(0, this.maxConcurrentParsing);
            FileUtils.logDebugForAssociations(`处理文件批次，数量: ${batch.length}`);

            // 并行处理这批文件
            const promises = batch.map(item =>
                this.updateFileIndex(item.uri, item.fullParse)
                    .catch(error => {
                        FileUtils.logError(`处理队列中的文件时出错: ${item.uri.fsPath}`, error);
                    })
            );

            await Promise.all(promises);

            // 继续处理队列中的下一批
            setImmediate(() => this.processFileQueue());
        } catch (error) {
            FileUtils.logError('处理文件队列时出错:', error);
            this.isProcessingQueue = false;
        }
    }

    /**
     * 更新可见文件列表
     */
    private updateVisibleFiles(): void {
        this.visibleFiles.clear();
        vscode.window.visibleTextEditors.forEach(editor => {
            if (editor.document.uri.scheme === 'file') {
                this.visibleFiles.add(editor.document.uri.fsPath);
            }
        });
    }

}
