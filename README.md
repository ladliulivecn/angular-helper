# Angular助手

这是"Angular助手"VS Code扩展的README文件。这个扩展旨在提高Angular开发的效率和便利性，特别是针对AngularJS项目。

## 功能

该扩展提供以下主要功能:

1. AngularJS文件解析
   - 解析和识别AngularJS特定语法和结构
   - 支持JavaScript和HTML文件的解析

2. 智能导航和定义查找
   - 在HTML模板和相关的JavaScript控制器之间快速跳转
   - 查看组件、指令、服务等的定义和引用

3. 性能优化
   - 使用LRU缓存策略，有效管理内存使用
   - 支持并发文件解析，提高大型项目的解析速度

## 要求

- VS Code 1.93.0 或更高版本
- 在工作区中包含AngularJS项目

## 扩展设置

该扩展提供以下设置:

* `angularDefinitionProvider.excludePatterns`: 用于排除解析的文件或文件夹的数组。默认值: `["doc/**"]`
* `angularDefinitionProvider.maxConcurrentParsing`: 同时解析的最大文件数。默认值: `5`
* `angularDefinitionProvider.maxCachedFiles`: 缓存中保存的最大文件数。默认值: `100`
* `angularDefinitionProvider.cacheTTL`: 缓存的生存时间(毫秒)。默认值: `3600000` (1小时)

## 使用方法

1. 在VS Code中打开一个AngularJS项目。
2. 扩展会自动开始解析项目文件。
3. 在HTML文件中，你可以通过Ctrl+点击（或命令/Ctrl+F12）来跳转到JavaScript中的定义。
4. 在JavaScript文件中，你可以同样方式跳转到HTML模板中的相关定义。

## 已知问题

- 暂时主要支持AngularJS (Angular 1.x) 项目，对于新版本的Angular支持可能有限。
- 在非常大的项目中，首次解析可能需要较长时间。

## 发布说明

### 1.0.0

- 初始发布
- 实现AngularJS文件解析
- 支持HTML和JS文件间的定义查看和跳转
- 添加可配置的排除模式、并发解析数和缓存大小

## 新功能

- 支持 Angular 表达式的智能识别和跳转
- 优化的文件搜索和解析逻辑,提高大型项目的性能

## 配置说明

* `angularDefinitionProvider.cacheTTL`: 缓存的生存时间(毫秒)。默认值: `3600000` (1小时)

## 使用技巧

- 在 HTML 文件中,你可以跳转到复杂的 Angular 表达式定义,如 `ng-click="ctrl.doSomething()"` 中的 `doSomething` 方法
- 扩展会自动监听文件变化并更新解析结果,无需手动刷新

## 性能优化

- 使用 LRU 缓存和并发解析来提高大型项目的性能
- 可以通过调整 `maxConcurrentParsing` 和 `maxCachedFiles` 设置来优化性能

## 未来计划



## 贡献

欢迎对本项目提出建议或贡献代码。请访问我们的[GitHub仓库](https://github.com/your-repo-link)来提交问题或拉取请求。

## 许可证

本扩展遵循 [MIT 许可证](LICENSE.md)。

---

## 故障排除

如果您在使用扩展时遇到问题，请尝试以下步骤：

1. 确保您的项目是一个有效的 AngularJS 项目。
2. 重新加载 VS Code 窗口（Ctrl+Shift+P 或 Cmd+Shift+P，然后输入 "Reload Window"）。
3. 检查 VS Code 的输出面板中是否有任何错误消息（查看 -> 输出，然后在下拉菜单中选择 "Angular 助手"）。
4. 如果问题仍然存在，请在我们的 GitHub 仓库中提交一个 issue。

## 详细使用说明

1. 在 HTML 文件中使用：
   - 将光标放在 ng-* 属性或 {{ }} 表达式上。
   - 使用 Ctrl+点击（Windows/Linux）或 Cmd+点击（Mac）跳转到定义。

2. 在 JavaScript 文件中使用：
   - 将光标放在 Angular 组件、控制器、服务或指令的名称上。
   - 使用 Ctrl+点击（Windows/Linux）或 Cmd+点击（Mac）跳转到 HTML 中的使用位置。

3. 性能优化：
   - 如果您的项目很大，可以通过增加 `maxConcurrentParsing` 和 `maxCachedFiles` 的值来提高性能。
   - 请注意，增加这些值可能会导致内存使用量增加。
