import LRUCache from 'lru-cache';
import * as vscode from 'vscode';
import { FileInfo } from '../types/types';

export class FileInfoManager {
    private fileMap!: LRUCache<string, FileInfo>;

    constructor(config: vscode.WorkspaceConfiguration) {
        this.updateConfiguration(config);
    }

    public updateConfiguration(config: vscode.WorkspaceConfiguration): void {
        const maxCachedFiles = config.get<number>('maxCachedFiles') || 100;
        const cacheTTL = config.get<number>('cacheTTL') || 60 * 60 * 1000;

        this.fileMap = new LRUCache<string, FileInfo>({
            max: maxCachedFiles,
            ttl: cacheTTL
        });
    }

    public setFileInfo(filePath: string, fileInfo: FileInfo): void {
        this.fileMap.set(filePath, fileInfo);
    }

    public getFileInfo(filePath: string): FileInfo | undefined {
        return this.fileMap.get(filePath);
    }

    public getAllParsedFiles(): string[] {
        return Array.from(this.fileMap.keys());
    }
}
