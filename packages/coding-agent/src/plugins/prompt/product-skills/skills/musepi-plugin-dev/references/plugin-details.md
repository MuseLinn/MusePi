# 插件详情页与本地化文案

插件页展示的标题、描述、配置表单和资源卡都来自清单，不是代码。

## 清单字段

`package.json` 的 `musepi` 块：

| 字段 | 用途 |
| --- | --- |
| `label` | 插件页标题 |
| `description` | 一句话说明它做什么、怎么用 |
| `icon` | 单个 emoji、`lucide:<name>`，或包内的图标文件 |
| `config` | 配置字段表，插件页据此渲染表单 |
| `resources` | 资源卡：`disk` / `memory` / `setupMinutes` / `models` |
| `components` | 子组件声明（见 `components-and-compatibility.md`） |

## 描述写什么

说明它做什么，以及**怎么用**——在界面上点哪里、触发词是什么，用界面上真实出现的标签。

把限制写进描述或配置项说明：会额外发起的模型请求、会读到或发送出去的数据、风险、关闭后哪些行为消失。用户是靠这段文字决定要不要开它的。

## 配置字段

`config` 是字段表：类型为 `boolean | number | string | select | path`，数字可带 `min/max/step`，下拉必须给 `options`，每个字段可标 `restart: none|session|daemon` 说明生效范围。

运行时用钳制后的值读取；未写过的键等于声明默认，坏值回退声明默认，未声明的键读不到。存储坏值与表单、写入共用同一条链路。

字段说明用用户能判断的话：「超时多少秒后放弃」好过「timeout 参数」。

## 本地化

`locale/<tag>.json` 提供各语言的 `label` / `description`。文件名就是语言标签（`zh-CN.json`、`en.json`）。

缺某个语言时按语言链回退；只翻译标题、不翻译描述会让详情页半本地化。新加语言就加一个文件，不需要改代码。

## 图标

单个 emoji 最快，适合内部插件。要精致一些用 `lucide:<name>`，界面按同一套图标集渲染。让插件自带图片时用包内相对路径，避免外链——外链在离线环境里会变成空白方块。