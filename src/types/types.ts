export interface AngularDefinition {
    name: string;
    position: number;
    type: string;
    value?: string;
    isDefinition: boolean;
}

export interface NgRepeatExpression {
    position: number;
    variables: string[];
}

export interface FileInfo {
    filePath: string;
    controllers: Map<string, AngularDefinition>;
    services: Map<string, AngularDefinition>;
    directives: Map<string, AngularDefinition>;
    functions: Map<string, AngularDefinition[]>;
    scopeVariables: Map<string, AngularDefinition>;
    components: Map<string, AngularDefinition>;
    ngAttributes: Map<string, AngularDefinition>;
    ngControllers: Map<string, AngularDefinition>;
    ngRepeatVariables: Map<string, NgRepeatExpression>;
    filters: Map<string, AngularDefinition[]>;
}

/**
 * 支持的语言常量
 * @constant
 */
export const SUPPORTED_LANGUAGES = {
    JAVASCRIPT: 'javascript',
    HTML: 'html'
} as const;
