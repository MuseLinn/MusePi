# @musepi/typescript-edit-benchmark

基于 TypeScript 源码突变的编辑基准测试套件——评估 agent 进行精确代码编辑的能力
（fixtures + 每模型结果）。

## 内容

- `fixtures.tar.gz` —— 基准测试 fixture 语料库
- `all_models_results.json` —— 各模型的记录结果

## 用法

```sh
bun run check      # biome + 类型检查
```