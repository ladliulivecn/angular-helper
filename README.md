# Angular 助手扩展

Angular 助手扩展是一个为 Visual Studio Code 设计的工具,旨在提高 AngularJS (1.x) 开发的效率。它提供了强大的定义查找功能,支持在 HTML 和 JavaScript 文件之间进行跳转。

## 系统要求

- Visual Studio Code 版本 1.93.0 或更高

## 功能

1. **定义查找**：
   - 在 HTML 文件中查找 AngularJS 表达式、指令和控制器的定义
   - 在 JavaScript 文件中查找 HTML 模板中使用的变量和函数

2. **跨文件跳转**：
   - 从 HTML 模板跳转到相关的 JavaScript 定义
   - 从 JavaScript 文件跳转到 HTML 模板中的使用位置

3. **实时解析**：
   - 在文件保存时自动更新解析结果
   - 优先解析当前打开的文件,提高响应速度

4. **性能优化**：
   - 使用 LRU 缓存来存储解析结果,提高查找速度
   - 批量处理文件解析,避免阻塞 UI
   - 支持并发解析,提高大型项目的解析速度

5. **配置选项**：
   - 可自定义缓存大小和缓存过期时间
   - 可配置需要排除的文件模式
   - 可启用性能日志记录和普通日志记录

## 使用方法

1. 确保你的 Visual Studio Code 版本不低于 1.93.0。
2. 在 VS Code 中安装 Angular 助手扩展。
3. 打开一个 AngularJS (1.x) 项目。
4. 在 HTML 或 JavaScript 文件中,将光标放在要查找定义的元素上。
5. 使用 "转到定义"（通常是 F12 键）或右键菜单中的 "转到定义" 选项。
6. 扩展将自动跳转到相应的定义位置。

## 配置选项

在 VS Code 的设置中,你可以自定义以下选项来优化 Angular 助手扩展的性能和行为：

### `angularHelper.ignorePatterns`
- **描述**：要忽略的文件、文件夹和脚本模式。
- **默认值**：  ```json
  [
    "*.min.js",
    "http://*",
    "https://*",
    "//cdn.*",
    ".git/**",
    ".history/**",
    ".idea/**",
    ".vscode/**",
    "doc/**"
  ]  ```
- **说明**：这个设置允许你指定应该被忽略的文件、文件夹和脚本模式。支持通配符。

### `angularHelper.definitionCacheSize`
- **描述**：定义缓存的大小,即可以同时缓存多少个定义位置。
- **默认值**：100
- **说明**：增加这个值可以提高频繁访问的定义的查找速度,但会占用更多内存。

### `angularHelper.enablePerformanceLogging`
- **描述**：是否启用性能日志记录。
- **默认值**：false
- **说明**：启用此选项后,扩展会在输出面板中记录各种操作的性能数据。

### `angularHelper.enableLogging`
- **描述**：是否启用普通日志记录。
- **默认值**：true
- **说明**：启用此选项后,扩展会在输出面板中记录详细的运行日志。

### `angularHelper.rootDirAliases`
- **描述**：根目录别名映射。
- **默认值**：  ```json
  {
    "__ROOT__": "./",
    "__PUBLIC__": "./Public"
  }  ```
- **说明**：这个设置允许你定义自定义的根目录别名。键是别名,值是相对于工作区根目录的路径。

### `angularHelper.resolvedPathCacheSize`
- **描述**：解析路径缓存大小。
- **默认值**：1000
- **说明**：这个设置控制可以同时缓存多少个已解析的路径。增加这个值可以提高性能,但会占用更多内存。

### `angularHelper.resolvedPathCacheTTL`
- **描述**：解析路径缓存生存时间(毫秒)。
- **默认值**：3600000 (1小时)
- **说明**：这个设置决定了缓存中的已解析路径多久后会失效。

### `angularDefinitionProvider.maxConcurrentParsing`
- **描述**：最大并发解析文件数。
- **默认值**：5
- **说明**：这个设置控制同时可以解析多少个文件。增加这个值可以加快初始化速度,但也会增加 CPU 和内存的使用。

### `angularDefinitionProvider.maxCachedFiles`
- **描述**：最大缓存文件数。
- **默认值**：100
- **说明**：这个设置控制可以同时缓存多少个已解析的文件信息。

### `angularDefinitionProvider.cacheTTL`
- **描述**：缓存的生存时间,单位为毫秒。
- **默认值**：3600000 (1小时)
- **说明**：这个设置决定了缓存中的项目多久后会失效。

### 如何修改配置

1. 在 VS Code 中,打开设置（File > Preferences > Settings）。
2. 搜索 "Angular Helper" 或 "Angular Definition Provider"。
3. 找到相应的设置项并修改其值。
4. 某些设置可能需要重新加载窗口才能生效。

注意：这些设置会影响扩展的性能和行为。如果你不确定如何设置,建议保持默认值或稍作调整后观察效果。

## 注意事项

- 该扩展需要 Visual Studio Code 1.93.0 或更高版本。
- 该扩展专门针对 AngularJS (Angular 1.x) 项目优化。
- 为了获得最佳性能,建议在较小的项目或限定的文件范围内使用。
- 首次使用时,扩展需要一定时间来解析项目文件。之后的使用将会更快。

## 反馈与贡献

如果你发现任何问题或有改进建议,欢迎在 GitHub 仓库中提出 issue 或提交 pull request。

感谢使用 Angular 助手扩展！
