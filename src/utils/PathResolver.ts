/* eslint-disable curly */
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import LRUCache from 'lru-cache';
import { FileUtils } from './FileUtils';

export class PathResolver {
    private ignorePatterns: string[];
    private rootDirAliases: { [key: string]: string };
    private resolvedPathCache: LRUCache<string, vscode.Uri | null>;
    private mockWorkspacePath: string | null = null;

    constructor(config: vscode.WorkspaceConfiguration) {
        this.ignorePatterns = config.get<string[]>('ignorePatterns') || [];
        this.rootDirAliases = config.get<{ [key: string]: string }>('rootDirAliases') || {};
        
        const resolvedPathCacheSize = config.get<number>('resolvedPathCacheSize') || 1000;
        const resolvedPathCacheTTL = config.get<number>('resolvedPathCacheTTL') || 3600000; // 默认1小时

        this.resolvedPathCache = new LRUCache<string, vscode.Uri | null>({
            max: resolvedPathCacheSize,
            ttl: resolvedPathCacheTTL
        });
    }

    public shouldIgnore(filePath: string): boolean {
        return this.ignorePatterns.some(pattern => 
            new RegExp(this.convertGlobToRegExp(pattern)).test(filePath)
        );
    }

    private convertGlobToRegExp(pattern: string): string {
        return pattern
            .replace(/\./g, '\\.')
            .replace(/\*\*/g, '.*')
            .replace(/\*/g, '[^/]*')
            .replace(/\?/g, '.')
            .replace(/\//g, '\\/');
    }

    public resolveScriptPath(scriptSrc: string, documentUri: vscode.Uri): vscode.Uri | null {

        FileUtils.logDebugForAssociations(`开始解析脚本路径: ${scriptSrc}`);

        if (this.shouldIgnore(scriptSrc)) {
            FileUtils.logDebugForAssociations(`脚本路径被忽略: ${scriptSrc}`);
            return null;
        }

        const cacheKey = `${documentUri.toString()}:${scriptSrc}`;
        const cachedResult = this.resolvedPathCache.get(cacheKey);
        if (cachedResult !== undefined) {
            FileUtils.logDebugForAssociations(`使用缓存结果: ${cachedResult}`);
            return cachedResult;
        }

        let resolvedPath: string = scriptSrc;

        // 处理根目录别名
        for (const [alias, replacement] of Object.entries(this.rootDirAliases)) {
            if (scriptSrc.startsWith(alias)) {
                resolvedPath = scriptSrc.replace(alias, replacement);
                FileUtils.logDebugForAssociations(`应用根目录别名, 新路径: ${resolvedPath}`);
                break;
            }
        }

        // 移除查询参数
        resolvedPath = resolvedPath.split('?')[0];
        FileUtils.logDebugForAssociations(`移除查询参数后的路径: ${resolvedPath}`);

        const basePath = this.getWorkspacePath(documentUri);
        const documentDir = path.dirname(documentUri.fsPath);
        FileUtils.logDebugForAssociations(`基础路径: ${basePath}, 文档目录: ${documentDir}`);

        // 处理相对路径和绝对路径
        if (path.isAbsolute(resolvedPath)) {
            FileUtils.logDebugForAssociations(`处理绝对路径: ${resolvedPath}`);
        } else if (resolvedPath.startsWith('./') || resolvedPath.startsWith('../')) {
            const currentDirPath = path.resolve(documentDir, resolvedPath);
            const rootDirPath = path.resolve(basePath, resolvedPath);
            
            if (fs.existsSync(currentDirPath)) {
                resolvedPath = currentDirPath;
                FileUtils.logDebugForAssociations(`使用当前目录路径: ${resolvedPath}`);
            } else if (fs.existsSync(rootDirPath)) {
                resolvedPath = rootDirPath;
                FileUtils.logDebugForAssociations(`使用根目录路径: ${resolvedPath}`);
            } else {
                FileUtils.logDebugForAssociations(`未找到有效路径, 返回null`);
                this.resolvedPathCache.set(cacheKey, null);
                return null;
            }
        } else {
            FileUtils.logDebugForAssociations(`处理其他类型的路径`);
            const possiblePaths = [
                path.resolve(documentDir, resolvedPath),
                path.resolve(basePath, resolvedPath)
            ];

            for (const possiblePath of possiblePaths) {
                if (fs.existsSync(possiblePath)) {
                    resolvedPath = possiblePath;
                    FileUtils.logDebugForAssociations(`找到有效路径: ${resolvedPath}`);
                    break;
                }
            }

            if (!fs.existsSync(resolvedPath)) {
                FileUtils.logDebugForAssociations(`未找到有效路径, 返回null`);
                this.resolvedPathCache.set(cacheKey, null);
                return null;
            }
        }

        // 确保使用正确的路径分隔符
        resolvedPath = path.normalize(resolvedPath).replace(/\\/g, '/');
        FileUtils.logDebugForAssociations(`最终解析的路径: ${resolvedPath}`);
        
        const result = vscode.Uri.file(resolvedPath);
        this.resolvedPathCache.set(cacheKey, result);
        return result;
    }

    public getWorkspacePath(documentUri: vscode.Uri): string {
        if (this.mockWorkspacePath) {
            return this.mockWorkspacePath;
        }
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(documentUri);
        if (workspaceFolder) {
            return workspaceFolder.uri.fsPath;
        }
        // 如果找不到工作区文件夹，使用文档所在目录为基准
        return path.dirname(documentUri.fsPath);
    }

    // 用于测试的方法，允许设置模拟的工作区路径
    public setMockWorkspacePath(mockPath: string | null): void {
        this.mockWorkspacePath = mockPath;
    }

    public updateConfiguration(config: vscode.WorkspaceConfiguration): void {
        this.rootDirAliases = config.get<{ [key: string]: string }>('rootDirAliases') || {};
        this.ignorePatterns = config.get<string[]>('ignorePatterns') || [];
        // 更新其他配置项...
    }
}
