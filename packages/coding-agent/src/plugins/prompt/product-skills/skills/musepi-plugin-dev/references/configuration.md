# 配置读取与持久化

插件**不自己写配置文件**。

## 读：`ctx.config`

```ts
const threshold = await ctx.config.get<number>("threshold"); // 钳制后的值，未写过 = 声明默认
const all = await ctx.config.getAll();                      // 完整值表，只含声明过的键
```

取值与插件页表单、写入共用同一条钳制链路：

- 存储里的坏值回退声明默认，不会抛错；
- 未在 `musepi.config` 声明的键读不到；
- `getAll()` 只返回声明过的键。

## 为什么没有写接口

`ctx.config` **只有 `get` 与 `getAll`**。这是刻意的：插件改变自己的配置，由用户在插件页操作，写入口在宿主手里。

因此：

- 不要去找、读、重写宿主的配置文件。那个文件属于用户，里面有别人的行、注释与表达式。
- 不要从包目录向上猜配置文件的位置。
- 需要「运行时可变的状态」，用它自己的存储（会话状态、插件自己的数据文件），不要伪装成配置。

如果确实需要用户改值，把字段声明进清单，让插件页渲染表单——用户改，值走同一条钳制链路回到 `ctx.config.get`。

## 声明字段

`musepi.config` 的字段表：`boolean | number | string | select | path`，数字可带 `min/max/step`，下拉必须给 `options`，每个字段可标 `restart: none|session|daemon` 说明生效范围。

生效范围要诚实：标了 `restart: session` 的字段改完，用户要新建会话才看到效果——写清楚，别让人以为立刻生效。