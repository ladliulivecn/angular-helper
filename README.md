# Angular助手

这是"Angular助手"VS Code扩展的README文件。这个扩展旨在提高Angular开发的效率和便利性。

## 功能

该扩展提供以下主要功能:

1. AngularJS文件解析
   - 解析和识别AngularJS特定语法和结构
   - 提供语法高亮和代码补全

2. HTML和JS文件之间的智能导航
   - 在HTML模板和相关的JavaScript/TypeScript控制器之间快速跳转
   - 查看组件、指令、服务等的定义和引用


> 提示: 我们建议使用简短、清晰的动画来展示扩展的主要功能。

## 要求

- VS Code 1.93.0 或更高版本
- 在工作区中包含Angular项目

## 扩展设置

该扩展提供以下设置:

* `angularHelper.enable`: 启用/禁用此扩展。
* `angularHelper.parseMode`: 设置解析模式,可选值为 `strict` 或 `loose`。

## 已知问题

- 暂时不支持Angular 1.x版本以下的项目
- 在非常大的项目中,首次解析可能需要较长时间

## 发布说明

### 1.0.0

- 初始发布
- 实现AngularJS文件解析
- 支持HTML和JS文件间的定义查看和跳转


---

## 遵循扩展指南

我们确保遵循了VS Code扩展开发的最佳实践。详情请参阅:

* [扩展指南](https://code.visualstudio.com/api/references/extension-guidelines)

## 更多信息

* [Visual Studio Code的Markdown支持](http://code.visualstudio.com/docs/languages/markdown)
* [Markdown语法参考](https://help.github.com/articles/markdown-basics/)

**祝使用愉快!**
