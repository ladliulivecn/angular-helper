import { FileInfo } from '../types/types';

export class FileInfoFactory {
    public static createEmpty(filePath: string): FileInfo {
        return {
            filePath,
            controllers: new Map(),
            services: new Map(),
            directives: new Map(),
            functions: new Map(),
            scopeVariables: new Map(),
            components: new Map(),
            ngAttributes: new Map(),
            ngControllers: new Map(),
            ngRepeatVariables: new Map(),
            filters: new Map()
        };
    }
} 