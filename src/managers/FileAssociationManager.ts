import * as path from 'path';
import * as vscode from 'vscode';
import { HtmlParser } from '../parsers/HtmlParser';
import { JavaScriptParser } from '../parsers/JavaScriptParser';
import { FileUtils } from '../utils/FileUtils';
import { FileInfoManager } from './FileInfoManager';

export class FileAssociationManager {
    private htmlToJsMap: Map<string, string[]> = new Map();
    private jsToHtmlMap: Map<string, string[]> = new Map();
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
        for (const file of files) {
            if (token.isCancellationRequested) {
                FileUtils.logDebugForAssociations('文件关联构建被取消');
                return;
            }

            const filePath = file.fsPath;
            const ext = path.extname(filePath).toLowerCase();

            if (ext === '.html') {
                FileUtils.logDebugForAssociations(`分析HTML文件: ${filePath}`);
                await this.analyzeHtmlFile(file);
            } else {
                FileUtils.logDebugForAssociations(`跳过非HTML文件: ${filePath}`);
            }
        }
        FileUtils.logDebugForAssociations('文件关联构建完成');
    }

    private async analyzeHtmlFile(file: vscode.Uri): Promise<void> {
        try {
            const document = await vscode.workspace.openTextDocument(file);
            FileUtils.logDebugForAssociations(`开始解析HTML文件: ${file.fsPath}`);
            const { fileInfo, associatedJsFiles } = await this.htmlParser.parseHtmlFile(document);

            // 建立关联关系
            this.htmlToJsMap.set(file.fsPath, associatedJsFiles);
            for (const jsFile of associatedJsFiles) {
                if (!this.jsToHtmlMap.has(jsFile)) {
                    this.jsToHtmlMap.set(jsFile, []);
                }
                const htmlFiles = this.jsToHtmlMap.get(jsFile)!;
                if (!htmlFiles.includes(file.fsPath)) {
                    htmlFiles.push(file.fsPath);
                    FileUtils.logDebugForAssociations(`为JS文件 ${jsFile} 添加关联的HTML文件: ${file.fsPath}`);
                }
            }

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
            const fileInfo = this.jsParser.parseJavaScriptFile(document);
            this.fileInfoManager.setFileInfo(file.fsPath, fileInfo);
        } catch (error) {
            FileUtils.logDebugForAssociations(`分析JS文件 ${file.fsPath} 时出错: ${error}`);
        }
    }

    public getAssociatedJsFiles(htmlFilePath: string): string[] {
        const jsFiles = this.htmlToJsMap.get(htmlFilePath) || [];
        FileUtils.logDebugForAssociations(`获取HTML文件 ${htmlFilePath} 关联的JS文件: ${jsFiles.join(', ')}`);
        return jsFiles;
    }

    public getAssociatedHtmlFiles(jsFilePath: string): string[] {
        const htmlFiles = this.jsToHtmlMap.get(jsFilePath) || [];
        FileUtils.logDebugForAssociations(`获取JS文件 ${jsFilePath} 关联的HTML文件: ${htmlFiles.join(', ')}`);
        return htmlFiles;
    }

    // 添加一个方法来清除特定文件的关联
    public clearAssociationsForFile(filePath: string): void {
        const ext = path.extname(filePath).toLowerCase();
        if (ext === '.html') {
            const jsFiles = this.htmlToJsMap.get(filePath) || [];
            this.htmlToJsMap.delete(filePath);
            for (const jsFile of jsFiles) {
                const htmlFiles = this.jsToHtmlMap.get(jsFile) || [];
                const index = htmlFiles.indexOf(filePath);
                if (index !== -1) {
                    htmlFiles.splice(index, 1);
                    if (htmlFiles.length === 0) {
                        this.jsToHtmlMap.delete(jsFile);
                    } else {
                        this.jsToHtmlMap.set(jsFile, htmlFiles);
                    }
                }
            }
        } else if (ext === '.js') {
            const htmlFiles = this.jsToHtmlMap.get(filePath) || [];
            this.jsToHtmlMap.delete(filePath);
            for (const htmlFile of htmlFiles) {
                const jsFiles = this.htmlToJsMap.get(htmlFile) || [];
                const index = jsFiles.indexOf(filePath);
                if (index !== -1) {
                    jsFiles.splice(index, 1);
                    if (jsFiles.length === 0) {
                        this.htmlToJsMap.delete(htmlFile);
                    } else {
                        this.htmlToJsMap.set(htmlFile, jsFiles);
                    }
                }
            }
        }
    }

    public updateConfiguration(config: vscode.WorkspaceConfiguration): void {
        // 如果有特定于 FileAssociationManager 的配置，可以在这里更新
        // 例如，可以清除现有的关联并重新构建
        // this.htmlToJsMap.clear();
        // this.jsToHtmlMap.clear();
        // 可能需要重新分析所有文件来重建关联
    }

    public setAssociation(htmlFilePath: string, jsFilePaths: string[]): void {
        this.htmlToJsMap.set(htmlFilePath, jsFilePaths);
        for (const jsFilePath of jsFilePaths) {
            if (!this.jsToHtmlMap.has(jsFilePath)) {
                this.jsToHtmlMap.set(jsFilePath, []);
            }
            const htmlFiles = this.jsToHtmlMap.get(jsFilePath)!;
            if (!htmlFiles.includes(htmlFilePath)) {
                htmlFiles.push(htmlFilePath);
            }
        }
        FileUtils.logDebugForAssociations(`设置HTML文件 ${htmlFilePath} 的关联JS文件: ${jsFilePaths.join(', ')}`);
    }
}
