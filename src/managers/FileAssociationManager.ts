import * as path from 'path';
import * as vscode from 'vscode';
import { HtmlParser } from '../parsers/HtmlParser';
import { JavaScriptParser } from '../parsers/JavaScriptParser';
import { FileUtils } from '../utils/FileUtils';
import { FileInfoManager } from './FileInfoManager';
import { BidirectionalMap } from '../utils/BidirectionalMap';

export class FileAssociationManager {
    private fileAssociations = new BidirectionalMap<string, string>();
    private htmlParser: HtmlParser;
    private jsParser: JavaScriptParser;
    private fileInfoManager: FileInfoManager;

    constructor(htmlParser: HtmlParser, jsParser: JavaScriptParser, fileInfoManager: FileInfoManager) {
        this.htmlParser = htmlParser;
        this.jsParser = jsParser;
        this.fileInfoManager = fileInfoManager;
    }

    public async buildFileAssociations(files: vscode.Uri[], token: vscode.CancellationToken): Promise<void> {
        FileUtils.logDebugForAssociations(`开始构建文件关联，文件数量: ${files.length}`);
        
        try {
            for (const file of files) {
                if (token.isCancellationRequested) {
                    FileUtils.logDebugForAssociations('文件关联构建被取消');
                    return;
                }

                try {
                    const filePath = file.fsPath;
                    const ext = path.extname(filePath).toLowerCase();

                    if (ext === '.html') {
                        FileUtils.logDebugForAssociations(`分析HTML文件: ${filePath}`);
                        await this.analyzeHtmlFile(file);
                    } else {
                        FileUtils.logDebugForAssociations(`跳过非HTML文件: ${filePath}`);
                    }
                } catch (error) {
                    FileUtils.logError(`处理文件 ${file.fsPath} 时出错`, error);
                }
            }

            // 在构建完成后验证关联的完整性
            if (!this.validateAssociations()) {
                FileUtils.logDebugForAssociations('警告：文件关联验证失败，可能存在不一致的双向映射');
            }
        } catch (error) {
            FileUtils.logDebugForAssociations(`构建文件关联时出错: ${error}`);
            throw error;
        }
        
        FileUtils.logDebugForAssociations('文件关联构建完成');
    }

    private async analyzeHtmlFile(file: vscode.Uri): Promise<void> {
        try {
            const document = await vscode.workspace.openTextDocument(file);
            FileUtils.logDebugForAssociations(`开始解析HTML文件: ${file.fsPath}`);
            
            // 先检查文件是否正在被解析
            if (this.htmlParser.isFileBeingParsed(file.fsPath)) {
                FileUtils.logDebugForAssociations(`跳过解析：文件 ${file.fsPath} 正在被解析`);
                return;
            }

            // 只有在文件没有被解析的情况下才进行解析
            const { fileInfo, associatedJsFiles } = await this.htmlParser.parseHtmlFile(document);
            
            // 设置关联关系
            this.fileAssociations.set(file.fsPath, associatedJsFiles);
            FileUtils.logDebugForAssociations(`为HTML文件 ${file.fsPath} 设置关联的JS文件: ${associatedJsFiles.join(', ')}`);

            // 存储HTML文件的解析结果
            this.fileInfoManager.setFileInfo(file.fsPath, fileInfo);

            // 解析关联的JS文件
            for (const jsFile of associatedJsFiles) {
                await this.analyzeJsFile(vscode.Uri.file(jsFile));
            }
        } catch (error) {
            FileUtils.logDebugForAssociations(`分析HTML文件 ${file.fsPath} 时出错: ${error}`);
        }
    }

    public async analyzeJsFile(file: vscode.Uri): Promise<void> {
        try {
            const document = await vscode.workspace.openTextDocument(file);
            FileUtils.logDebugForAssociations(`开始解析JS文件: ${file.fsPath}`);
            
            if (this.jsParser.isFileBeingParsed(file.fsPath)) {
                FileUtils.logDebugForAssociations(`跳过解析：文件 ${file.fsPath} 正在被解析`);
                return;
            }

            const fileInfo = await this.jsParser.parseJavaScriptFile(document);
            this.fileInfoManager.setFileInfo(file.fsPath, fileInfo);
        } catch (error) {
            FileUtils.logDebugForAssociations(`分析JS文件 ${file.fsPath} 时出错: ${error}`);
        }
    }

    public getAssociatedJsFiles(htmlFilePath: string): string[] {
        return this.fileAssociations.getForward(htmlFilePath) || [];
    }

    public getAssociatedHtmlFiles(jsFilePath: string): string[] {
        return this.fileAssociations.getReverse(jsFilePath) || [];
    }

    // 添加一个方法来清除特定文件的关联
    public clearAssociationsForFile(filePath: string): void {
        const ext = path.extname(filePath).toLowerCase();
        if (ext === '.html') {
            this.fileAssociations.deleteForward(filePath);
        } else if (ext === '.js') {
            this.fileAssociations.deleteReverse(filePath);
        }
    }

    public setAssociation(htmlFilePath: string, jsFilePaths: string[]): void {
        this.fileAssociations.set(htmlFilePath, jsFilePaths);
    }

    public validateAssociations(): boolean {
        // 验证 HTML -> JS 的关联
        for (const [htmlFile, jsFiles] of this.fileAssociations.getForwardEntries()) {
            for (const jsFile of jsFiles) {
                const htmlFiles = this.fileAssociations.getReverse(jsFile);
                if (!htmlFiles?.includes(htmlFile)) {
                    return false;
                }
            }
        }
        return true;
    }
}
