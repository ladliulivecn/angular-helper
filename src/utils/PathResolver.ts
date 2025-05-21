/* eslint-disable curly */
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { FileUtils } from './FileUtils';
import { CacheManager } from './CacheManager';

export class PathResolver {
    private ignorePatterns: string[];
    private rootDirAliases: { [key: string]: string };
    private cacheManager: CacheManager;
    private mockWorkspacePath: string | null = null;

    constructor(config: vscode.WorkspaceConfiguration) {
        this.ignorePatterns = config.get<string[]>('ignorePatterns') || [];
        this.rootDirAliases = config.get<{ [key: string]: string }>('rootDirAliases') || {};
        this.cacheManager = CacheManager.getInstance(config);
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
        const cachedResult = this.cacheManager.getPathCache(cacheKey);
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
            // 检查绝对路径是否存在
            if (!fs.existsSync(resolvedPath)) {
                // 如果绝对路径不存在，尝试使用基础路径 + 绝对路径
                const combinedPath = path.join(basePath, resolvedPath);
                FileUtils.logDebugForAssociations(`尝试基础路径 + 绝对路径: ${combinedPath}`);
                if (fs.existsSync(combinedPath)) {
                    resolvedPath = combinedPath;
                    FileUtils.logDebugForAssociations(`使用组合路径: ${resolvedPath}`);
                } else {
                    // 如果仍然不存在，尝试将前导斜杠移除后与基础路径组合
                    const withoutLeadingSlash = resolvedPath.replace(/^[\/\\]/, '');
                    const alternativePath = path.join(basePath, withoutLeadingSlash);
                    FileUtils.logDebugForAssociations(`尝试移除前导斜杠后的路径: ${alternativePath}`);
                    if (fs.existsSync(alternativePath)) {
                        resolvedPath = alternativePath;
                        FileUtils.logDebugForAssociations(`使用移除前导斜杠后的路径: ${resolvedPath}`);
                    } else {
                        FileUtils.logDebugForAssociations(`未找到有效的绝对路径, 返回null`);
                        this.cacheManager.setPathCache(cacheKey, null);
                        return null;
                    }
                }
            }
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
                this.cacheManager.setPathCache(cacheKey, null);
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
                this.cacheManager.setPathCache(cacheKey, null);
                return null;
            }
        }

        // 确保使用正确的路径分隔符
        resolvedPath = path.normalize(resolvedPath).replace(/\\/g, '/');
        FileUtils.logDebugForAssociations(`最终解析的路径: ${resolvedPath}`);

        const result = vscode.Uri.file(resolvedPath);
        this.cacheManager.setPathCache(cacheKey, result);
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
        this.cacheManager = CacheManager.getInstance(config);
    }

    public resolveHtmlPath(componentName: string, documentUri: vscode.Uri): vscode.Uri | null {
        // 使用缓存
        const cacheKey = `html:${documentUri.toString()}:${componentName}`;
        const cachedResult = this.cacheManager.getPathCache(cacheKey);
        if (cachedResult !== undefined) {
            FileUtils.logDebugForAssociations(`使用缓存的HTML路径结果: ${cachedResult}`);
            return cachedResult;
        }

        const basePath = this.getWorkspacePath(documentUri);
        const documentDir = path.dirname(documentUri.fsPath);
        const possibleExtensions = ['.html', '.component.html', '.template.html'];

        // 可能的文件夹位置（从最可能到最不可能）
        const possibleFolders = [
            // 1. 同一目录
            documentDir,
            // 2. 组件子目录
            path.join(documentDir, componentName),
            // 3. 常见的 Angular 目录结构
            path.join(basePath, 'components', componentName),
            path.join(basePath, 'app', componentName),
            path.join(basePath, 'src', 'app', componentName),
            // 4. 其他可能的目录
            path.join(basePath, 'components'),
            path.join(basePath, 'app'),
            path.join(basePath, 'src', 'app'),
            // 5. 根目录
            basePath
        ];

        // 尝试所有可能的组合
        for (const folder of possibleFolders) {
            for (const ext of possibleExtensions) {
                // 尝试直接使用组件名
                let possiblePath = path.join(folder, componentName + ext);
                if (fs.existsSync(possiblePath)) {
                    const result = vscode.Uri.file(possiblePath);
                    this.cacheManager.setPathCache(cacheKey, result);
                    return result;
                }

                // 尝试转换为短横线命名法（kebab-case）
                const kebabName = this.camelToKebabCase(componentName);
                if (kebabName !== componentName) {
                    possiblePath = path.join(folder, kebabName + ext);
                    if (fs.existsSync(possiblePath)) {
                        const result = vscode.Uri.file(possiblePath);
                        this.cacheManager.setPathCache(cacheKey, result);
                        return result;
                    }
                }
            }
        }

        // 缓存未找到的结果
        this.cacheManager.setPathCache(cacheKey, null);
        return null;
    }

    private camelToKebabCase(str: string): string {
        return str.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
    }
}
