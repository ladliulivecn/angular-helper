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
    
    // 添加内存管理相关的常量
    private readonly MAX_PATH_LENGTH = 260; // Windows MAX_PATH 限制
    private readonly MAX_CACHE_MEMORY = 100 * 1024 * 1024; // 100MB 缓存内存限制
    private readonly CACHE_CLEANUP_INTERVAL = 300000; // 5分钟清理一次缓存
    private readonly MAX_RESOLVE_ATTEMPTS = 3; // 最大解析尝试次数
    
    // 添加计数器和时间戳
    private resolveAttempts = new Map<string, number>();
    private lastCleanupTime = Date.now();
    private memoryUsage = 0;
    
    // 添加文件关联追踪
    private fileAssociationMap = new Map<string, Set<string>>();
    private readonly MAX_ASSOCIATIONS_PER_FILE = 10;

    constructor(config: vscode.WorkspaceConfiguration) {
        this.ignorePatterns = config.get<string[]>('ignorePatterns') || [];
        this.rootDirAliases = config.get<{ [key: string]: string }>('rootDirAliases') || {};
        
        const resolvedPathCacheSize = Math.min(
            config.get<number>('resolvedPathCacheSize') || 1000,
            5000 // 设置一个合理的上限
        );
        const resolvedPathCacheTTL = config.get<number>('resolvedPathCacheTTL') || 3600000;

        this.resolvedPathCache = new LRUCache<string, vscode.Uri | null>({
            max: resolvedPathCacheSize,
            ttl: resolvedPathCacheTTL,
            dispose: (value, key) => {
                // 在条目被移除时更新内存使用量和关联记录
                this.memoryUsage -= this.estimateEntrySize(key, value);
                if (value instanceof vscode.Uri) {
                    this.removeFileAssociation(key, value.fsPath);
                }
            }
        });

        // 定期清理缓存
        setInterval(() => this.cleanupCache(), this.CACHE_CLEANUP_INTERVAL);
    }

    private estimateEntrySize(key: string, value: vscode.Uri | null): number {
        // 估算缓存条目的内存大小（字节）
        const keySize = key.length * 2; // JavaScript 字符串是 UTF-16
        const valueSize = value ? value.toString().length * 2 : 0;
        return keySize + valueSize + 32; // 32 字节作为对象开销
    }

    private removeFileAssociation(cacheKey: string, filePath: string): void {
        const associations = this.fileAssociationMap.get(filePath);
        if (associations) {
            associations.delete(cacheKey);
            if (associations.size === 0) {
                this.fileAssociationMap.delete(filePath);
            }
        }
    }

    private addFileAssociation(cacheKey: string, filePath: string): boolean {
        let associations = this.fileAssociationMap.get(filePath);
        if (!associations) {
            associations = new Set<string>();
            this.fileAssociationMap.set(filePath, associations);
        }

        // 检查是否已经存在相同的关联
        if (associations.has(cacheKey)) {
            return false;
        }

        // 检查关联数量是否超过限制
        if (associations.size >= this.MAX_ASSOCIATIONS_PER_FILE) {
            FileUtils.logDebugForAssociations(`文件 ${filePath} 的关联数量超过限制，跳过添加新关联`);
            return false;
        }

        associations.add(cacheKey);
        return true;
    }

    private cleanupCache(): void {
        try {
            const now = Date.now();
            if (now - this.lastCleanupTime < this.CACHE_CLEANUP_INTERVAL) {
                return;
            }

            // 清理解析尝试计数器
            for (const [key, timestamp] of this.resolveAttempts.entries()) {
                if (now - timestamp > 3600000) { // 1小时后清理
                    this.resolveAttempts.delete(key);
                }
            }

            // 清理文件关联映射
            for (const [filePath, associations] of this.fileAssociationMap.entries()) {
                // 验证所有关联是否仍然有效
                for (const cacheKey of Array.from(associations)) {
                    const cachedValue = this.resolvedPathCache.get(cacheKey);
                    if (!cachedValue) {
                        associations.delete(cacheKey);
                    }
                }
                // 如果没有有效关联，删除整个映射
                if (associations.size === 0) {
                    this.fileAssociationMap.delete(filePath);
                }
            }

            // 如果内存使用超过限制，采用渐进式清理策略
            if (this.memoryUsage > this.MAX_CACHE_MEMORY) {
                const targetSize = this.MAX_CACHE_MEMORY * 0.7; // 目标降至70%
                const entries = Array.from(this.resolvedPathCache.entries())
                    .sort((a, b) => {
                        const aTime = (a[1] as any)?.lastAccess || 0;
                        const bTime = (b[1] as any)?.lastAccess || 0;
                        return aTime - bTime;
                    });

                let currentMemory = this.memoryUsage;
                for (const [key, value] of entries) {
                    if (currentMemory <= targetSize) break;
                    
                    // 在删除之前验证路径是否仍然有效
                    if (value instanceof vscode.Uri) {
                        try {
                            if (!fs.existsSync(value.fsPath)) {
                                this.resolvedPathCache.delete(key);
                                const entrySize = this.estimateEntrySize(key, value);
                                currentMemory -= entrySize;
                                this.memoryUsage = currentMemory;
                            }
                        } catch (e) {
                            // 如果验证失败，删除缓存项
                            this.resolvedPathCache.delete(key);
                            const entrySize = this.estimateEntrySize(key, value);
                            currentMemory -= entrySize;
                            this.memoryUsage = currentMemory;
                        }
                    }
                }
            }

            this.lastCleanupTime = now;
            FileUtils.logDebugForAssociations(
                `缓存清理完成，当前内存使用: ${this.memoryUsage} 字节, ` +
                `缓存项数: ${this.resolvedPathCache.size}, ` +
                `文件关联数: ${this.fileAssociationMap.size}`
            );
        } catch (error) {
            FileUtils.logError('缓存清理出错:', error);
        }
    }

    public shouldIgnore(filePath: string): boolean {
        try {
            if (!filePath || filePath.length > this.MAX_PATH_LENGTH) {
                return true;
            }
            return this.ignorePatterns.some(pattern => 
                new RegExp(this.convertGlobToRegExp(pattern)).test(filePath)
            );
        } catch (error) {
            FileUtils.logError('路径检查出错:', error);
            return true;
        }
    }

    private convertGlobToRegExp(pattern: string): string {
        try {
            return pattern
                .replace(/\./g, '\\.')
                .replace(/\*\*/g, '.*')
                .replace(/\*/g, '[^/]*')
                .replace(/\?/g, '.')
                .replace(/\//g, '\\/');
        } catch (error) {
            FileUtils.logError('转换 glob 模式出错:', error);
            return pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // 转义为普通字符串
        }
    }

    public resolveScriptPath(scriptSrc: string, documentUri: vscode.Uri): vscode.Uri | null {
        try {
            if (!scriptSrc || !documentUri) {
                return null;
            }

            // 生成规范化的缓存键
            const normalizedScriptSrc = this.normalizeScriptPath(scriptSrc);
            const cacheKey = `${documentUri.toString()}:${normalizedScriptSrc}`;

            // 检查缓存
            const cachedResult = this.resolvedPathCache.get(cacheKey);
            if (cachedResult !== undefined) {
                FileUtils.logDebugForAssociations(`使用缓存结果: ${cachedResult}`);
                return cachedResult;
            }

            // 检查解析尝试次数
            const attempts = this.resolveAttempts.get(cacheKey) || 0;
            if (attempts >= this.MAX_RESOLVE_ATTEMPTS) {
                FileUtils.logDebugForAssociations(`超过最大解析尝试次数: ${scriptSrc}`);
                return null;
            }
            this.resolveAttempts.set(cacheKey, attempts + 1);

            FileUtils.logDebugForAssociations(`开始解析脚本路径: ${scriptSrc}`);

            if (this.shouldIgnore(scriptSrc)) {
                FileUtils.logDebugForAssociations(`脚本路径被忽略: ${scriptSrc}`);
                return null;
            }

            let resolvedPath: string = normalizedScriptSrc;

            // 处理根目录别名
            for (const [alias, replacement] of Object.entries(this.rootDirAliases)) {
                if (normalizedScriptSrc.startsWith(alias)) {
                    resolvedPath = normalizedScriptSrc.replace(alias, replacement);
                    FileUtils.logDebugForAssociations(`应用根目录别名, 新路径: ${resolvedPath}`);
                    break;
                }
            }

            // 移除查询参数和哈希
            resolvedPath = resolvedPath.split(/[?#]/)[0];
            FileUtils.logDebugForAssociations(`移除查询参数后的路径: ${resolvedPath}`);

            const basePath = this.getWorkspacePath(documentUri);
            const documentDir = path.dirname(documentUri.fsPath);
            FileUtils.logDebugForAssociations(`基础路径: ${basePath}, 文档目录: ${documentDir}`);

            // 处理相对路径和绝对路径
            const result = this.tryResolvePath(resolvedPath, basePath, documentDir);
            if (result) {
                // 检查是否已存在相同的文件关联
                if (this.addFileAssociation(cacheKey, result.fsPath)) {
                    // 更新缓存和内存使用量
                    const newEntrySize = this.estimateEntrySize(cacheKey, result);
                    if (this.memoryUsage + newEntrySize <= this.MAX_CACHE_MEMORY) {
                        this.resolvedPathCache.set(cacheKey, result);
                        this.memoryUsage += newEntrySize;
                    }
                } else {
                    FileUtils.logDebugForAssociations(`跳过重复的文件关联: ${result.fsPath}`);
                }
            }

            return result;
        } catch (error) {
            FileUtils.logError('解析脚本路径时出错:', error);
            return null;
        }
    }

    private normalizeScriptPath(scriptSrc: string): string {
        // 标准化路径，移除重复的斜杠，统一分隔符
        return scriptSrc
            .replace(/\\/g, '/')  // 统一使用正斜杠
            .replace(/\/+/g, '/') // 移除重复的斜杠
            .replace(/^\.\/+/, '') // 移除开头的 ./
            .toLowerCase();       // 转换为小写以避免大小写导致的重复
    }

    private tryResolvePath(resolvedPath: string, basePath: string, documentDir: string): vscode.Uri | null {
        try {
            // 标准化路径分隔符
            resolvedPath = resolvedPath.replace(/\\/g, '/');
            basePath = basePath.replace(/\\/g, '/');
            documentDir = documentDir.replace(/\\/g, '/');
            // 收集所有可能的路径
            const possiblePaths = new Set<string>();
            if (path.isAbsolute(resolvedPath)) {                
                // 以 / 开头的绝对路径
                const withoutLeadingSlash = resolvedPath.replace(/^\/+/, '');
                possiblePaths.add(path.join(basePath, withoutLeadingSlash));
            }

            // 处理相对路径
            if (resolvedPath.startsWith('./') || resolvedPath.startsWith('../')) {
                possiblePaths.add(path.resolve(documentDir, resolvedPath));
                possiblePaths.add(path.resolve(basePath, resolvedPath));
            }


            // 添加其他可能的路径组合
            possiblePaths.add(path.resolve(documentDir, resolvedPath));
            possiblePaths.add(path.resolve(basePath, resolvedPath));

            // 尝试所有可能的路径
            for (const possiblePath of possiblePaths) {
                try {
                    if (fs.existsSync(possiblePath)) {
                        const normalizedPath = path.normalize(possiblePath).replace(/\\/g, '/');
                        FileUtils.logDebugForAssociations(`成功解析路径: ${normalizedPath}`);
                        return vscode.Uri.file(normalizedPath);
                    }
                } catch (e) {
                    // 忽略单个路径检查的错误，继续检查其他路径
                    FileUtils.logDebugForAssociations(`检查路径失败: ${possiblePath}, 错误: ${e}`);
                    continue;
                }
            }

            FileUtils.logDebugForAssociations(`无法解析路径: ${resolvedPath}, 尝试的路径: ${Array.from(possiblePaths).join(', ')}`);
            return null;
        } catch (error) {
            FileUtils.logError('尝试解析路径时出错:', error);
            return null;
        }
    }

    public getWorkspacePath(documentUri: vscode.Uri): string {
        try {
            if (this.mockWorkspacePath) {
                return this.mockWorkspacePath;
            }
            const workspaceFolder = vscode.workspace.getWorkspaceFolder(documentUri);
            return workspaceFolder ? workspaceFolder.uri.fsPath : path.dirname(documentUri.fsPath);
        } catch (error) {
            FileUtils.logError('获取工作区路径时出错:', error);
            return path.dirname(documentUri.fsPath);
        }
    }

    public setMockWorkspacePath(mockPath: string | null): void {
        this.mockWorkspacePath = mockPath;
    }

    public updateConfiguration(config: vscode.WorkspaceConfiguration): void {
        try {
            this.rootDirAliases = config.get<{ [key: string]: string }>('rootDirAliases') || {};
            this.ignorePatterns = config.get<string[]>('ignorePatterns') || [];
            
            // 更新缓存配置
            const newCacheSize = Math.min(
                config.get<number>('resolvedPathCacheSize') || 1000,
                5000
            );
            const newTTL = config.get<number>('resolvedPathCacheTTL') || 3600000;
            
            // 如果缓存配置发生变化，重新创建缓存
            if (this.resolvedPathCache.max !== newCacheSize || 
                (this.resolvedPathCache as any).ttl !== newTTL) {
                const oldCache = this.resolvedPathCache;
                this.resolvedPathCache = new LRUCache<string, vscode.Uri | null>({
                    max: newCacheSize,
                    ttl: newTTL,
                    dispose: (value, key) => {
                        this.memoryUsage -= this.estimateEntrySize(key, value);
                    }
                });
                
                // 迁移旧缓存中的数据
                oldCache.forEach((value, key) => {
                    const entrySize = this.estimateEntrySize(key, value);
                    if (this.memoryUsage + entrySize <= this.MAX_CACHE_MEMORY) {
                        this.resolvedPathCache.set(key, value);
                        this.memoryUsage += entrySize;
                    }
                });
            }
        } catch (error) {
            FileUtils.logError('更新配置时出错:', error);
        }
    }
}
