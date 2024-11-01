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

    // 保留主要的公共方法，但简化实现
    public async initializeParser(files: vscode.Uri[], token: vscode.CancellationToken): Promise<void> {
        FileUtils.log(`开始初始化解析器，传入的文件数量: ${files.length}`);

        const filteredFiles = files.filter(file => !this.pathResolver.shouldIgnore(file.fsPath));
        FileUtils.log(`过滤后的文件数量: ${filteredFiles.length}`);

        await this.fileAssociationManager.buildFileAssociations(filteredFiles, token);
        this.parseQueue = filteredFiles;
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
                const batch = this.parseQueue.splice(0, this.maxConcurrentParsing);
                await Promise.all(batch.map(file => this.parseFile(file)));
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

    private async shouldUseCache(file: vscode.Uri, fileInfo: FileInfo): Promise<boolean> {
        try {
            const stat = await vscode.workspace.fs.stat(file);
            const cachedStat = await vscode.workspace.fs.stat(vscode.Uri.file(fileInfo.filePath));
            return stat.mtime === cachedStat.mtime;
        } catch (error) {
            FileUtils.logError(`检查文件缓存状态失败: ${file.fsPath}`, error);
            return false;
        }
    }

    public async parseFile(file: vscode.Uri): Promise<void> {
        const filePath = file.fsPath;
        if (this.isFileBeingParsed(filePath)) {
            FileUtils.log(`跳过正在解析的文件: ${filePath}`);
            return;
        }

        // 检查文件是否已经被解析过且未修改
        const fileInfo = this.fileInfoManager.getFileInfo(filePath);
        if (fileInfo && await this.shouldUseCache(file, fileInfo)) {
            FileUtils.logDebugForAssociations(`使用缓存的文件解析结果: ${filePath}`);
            return;
        }

        this.markFileAsParsing(filePath);

        try {
            const document = await vscode.workspace.openTextDocument(file);
            
            if (document.languageId === SUPPORTED_LANGUAGES.JAVASCRIPT) {
                const fileInfo = this.jsParser.parseJavaScriptFile(document);
                this.fileInfoManager.setFileInfo(filePath, fileInfo);
            } else if (document.languageId === SUPPORTED_LANGUAGES.HTML) {
                const { fileInfo, associatedJsFiles } = await this.htmlParser.parseHtmlFile(document);
                this.fileInfoManager.setFileInfo(filePath, fileInfo);
                
                // 更新文件关联
                this.fileAssociationManager.clearAssociationsForFile(filePath);
                this.fileAssociationManager.setAssociation(filePath, associatedJsFiles);
                
                // 解析关联文件                
                await this.parseAssociatedFiles(associatedJsFiles);
            }
        } catch (error) {
            FileUtils.logError(`解析文件失败: ${filePath}`, error);
        } finally {
            this.markFileAsFinishedParsing(filePath);
        }
    }

    private async parseAssociatedFiles(files: string[]): Promise<void> {
        await Promise.all(
            files
                .filter(file => !this.isFileBeingParsed(file))
                .map(file => this.parseFile(vscode.Uri.file(file)))
        );
    }

    public async prioritizeCurrentFile(document: vscode.TextDocument): Promise<void> {
        if (['html', 'javascript'].includes(document.languageId)) {
            await this.parseFile(document.uri);

            if (document.languageId === SUPPORTED_LANGUAGES.HTML) {
                const jsFiles = this.fileAssociationManager.getAssociatedJsFiles(document.fileName);
                await this.parseAssociatedFiles(jsFiles);
            } else if (document.languageId === SUPPORTED_LANGUAGES.JAVASCRIPT) {
                const htmlFiles = this.fileAssociationManager.getAssociatedHtmlFiles(document.fileName);
                await this.parseAssociatedFiles(htmlFiles);
            }
        }
    }

    public async updateFileIndex(fileUri: vscode.Uri): Promise<void> {
        const absolutePath = fileUri.fsPath;
        const fileExtension = path.extname(absolutePath).toLowerCase();

        try {
            if (!await FileUtils.fileExists(fileUri)) {
                return;
            }

            if (fileExtension === '.html') {
                await this.updateHtmlFileIndex(fileUri);
            } else if (fileExtension === '.js') {
                await this.updateJsFileIndex(fileUri);
            } else {
                throw new Error(`不支持的文件类型: ${fileExtension}, 文件: ${absolutePath}`);
            }

            FileUtils.logDebugForAssociations(`文件索引更新完成: ${absolutePath}`);
        } catch (error) {
            FileUtils.logError(`更新文件索引时出错 ${absolutePath}:`, error);
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
            
            // 并行解析关联的 JS 文件
            await this.parseAssociatedFiles(associatedJsFiles);
        } catch (error) {
            FileUtils.logError(`更新HTML文件索引时出错 ${filePath}:`, error);
            throw error;
        }
    }

    private async updateJsFileIndex(fileUri: vscode.Uri): Promise<void> {
        const filePath = fileUri.fsPath;
        try {
            const document = await vscode.workspace.openTextDocument(fileUri);
            const fileInfo = this.jsParser.parseJavaScriptFile(document);
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

}
