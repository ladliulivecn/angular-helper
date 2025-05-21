import LRUCache from 'lru-cache';
import * as vscode from 'vscode';
import { FileUtils } from './FileUtils';

/**
 * 统一缓存管理类
 * 用于管理扩展中的各种缓存
 */
export class CacheManager {
    private static instance: CacheManager;
    
    // 路径解析缓存
    private pathCache: LRUCache<string, vscode.Uri | null>;
    
    // 文件内容哈希缓存
    private contentHashCache: LRUCache<string, string>;
    
    // 文件关联缓存
    private associationCache: LRUCache<string, string[]>;
    
    // 缓存配置
    private cacheTTL: number;
    private maxCacheSize: number;
    
    private constructor(config: vscode.WorkspaceConfiguration) {
        this.updateConfiguration(config);
        
        this.pathCache = new LRUCache<string, vscode.Uri | null>({
            max: this.maxCacheSize,
            ttl: this.cacheTTL
        });
        
        this.contentHashCache = new LRUCache<string, string>({
            max: this.maxCacheSize,
            ttl: this.cacheTTL
        });
        
        this.associationCache = new LRUCache<string, string[]>({
            max: this.maxCacheSize,
            ttl: this.cacheTTL
        });
    }
    
    /**
     * 获取缓存管理器实例
     * @param config 工作区配置
     * @returns 缓存管理器实例
     */
    public static getInstance(config?: vscode.WorkspaceConfiguration): CacheManager {
        if (!CacheManager.instance) {
            if (!config) {
                config = vscode.workspace.getConfiguration('angularHelper');
            }
            CacheManager.instance = new CacheManager(config);
        } else if (config) {
            CacheManager.instance.updateConfiguration(config);
        }
        
        return CacheManager.instance;
    }
    
    /**
     * 更新配置
     * @param config 工作区配置
     */
    public updateConfiguration(config: vscode.WorkspaceConfiguration): void {
        this.cacheTTL = config.get<number>('resolvedPathCacheTTL') || 3600000; // 默认1小时
        this.maxCacheSize = config.get<number>('resolvedPathCacheSize') || 1000;
    }
    
    /**
     * 获取路径缓存
     * @param key 缓存键
     * @returns 缓存的URI或null
     */
    public getPathCache(key: string): vscode.Uri | null | undefined {
        return this.pathCache.get(key);
    }
    
    /**
     * 设置路径缓存
     * @param key 缓存键
     * @param value 缓存值
     */
    public setPathCache(key: string, value: vscode.Uri | null): void {
        this.pathCache.set(key, value);
    }
    
    /**
     * 获取内容哈希缓存
     * @param filePath 文件路径
     * @returns 缓存的哈希值
     */
    public getContentHash(filePath: string): string | undefined {
        return this.contentHashCache.get(filePath);
    }
    
    /**
     * 设置内容哈希缓存
     * @param filePath 文件路径
     * @param hash 哈希值
     */
    public setContentHash(filePath: string, hash: string): void {
        this.contentHashCache.set(filePath, hash);
    }
    
    /**
     * 获取文件关联缓存
     * @param filePath 文件路径
     * @returns 缓存的关联文件列表
     */
    public getAssociations(filePath: string): string[] | undefined {
        return this.associationCache.get(filePath);
    }
    
    /**
     * 设置文件关联缓存
     * @param filePath 文件路径
     * @param associations 关联文件列表
     */
    public setAssociations(filePath: string, associations: string[]): void {
        this.associationCache.set(filePath, associations);
    }
    
    /**
     * 清除文件的所有缓存
     * @param filePath 文件路径
     */
    public clearFileCache(filePath: string): void {
        // 清除内容哈希缓存
        this.contentHashCache.delete(filePath);
        
        // 清除关联缓存
        this.associationCache.delete(filePath);
        
        // 清除包含此文件路径的路径缓存
        const pathCacheKeys = Array.from(this.pathCache.keys()).filter(key => key.includes(filePath));
        for (const key of pathCacheKeys) {
            this.pathCache.delete(key);
        }
        
        FileUtils.logDebugForAssociations(`清除文件缓存: ${filePath}`);
    }
    
    /**
     * 清除所有缓存
     */
    public clearAllCaches(): void {
        this.pathCache.clear();
        this.contentHashCache.clear();
        this.associationCache.clear();
        FileUtils.log('已清除所有缓存');
    }
}
