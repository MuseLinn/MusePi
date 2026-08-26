# ArkType 指南（本仓库 Zod → ArkType 迁移）

[English](arktype-guide.md) | 中文

本指南锁定 **arktype 2.2.0**（已安装）。内容已根据当前已安装的 `.d.ts` 与运行时 session 验证。类型请用 `import { type } from "arktype"` 编写。

本指南锁定 **arktype 2.2.0**（已安装）。内容已根据当前已安装的 `.d.ts` 与运行时 session 验证。类型请用 `import { type } from "arktype"` 编写。

> **范围规则（请先读）。** Zod 在**外部边界**仍受支持——`Tool.parameters` 接受 Zod *或* ArkType *或* JSON Schema，公开的 `pi.zod` 扩展 API 与基于 Zod 的 `typebox` shim 均不受影响。请将**内部** schema 迁移到 ArkType。如果某个文件确实无法用 ArkType 干净表达（见下方的“健壮解析”），并且它解析外部/不可信 payload，可以**保留 Zod**——请在报告中说明，而不是交付破损的 ArkType。

## 检测契约（不要破坏它）

`packages/ai/src/utils/schema/wire.ts` 区分三类 schema：

- **ArkType** = 带 `.toJsonSchema` 与 `.assert` 方法的**可调用函数**（`isArkSchema`）。
- **Zod** = 不可调用对象，携带 `_zod` + `.parse`（`isZodSchema`）。
- **JSON Schema** = 普通对象。

因此 ArkType `Type` 是一个函数。**切勿**通过 `$` / `_arktype` / `__arktype` 标记检测——这些都不存在。`isArkSchema`、`arkToWireSchema`、`isZodSchema`、`zodToWireSchema` 继续导出。

## 核心对照表（Zod → ArkType）

| Zod | ArkType |
|---|---|
| `z.object({ a: ... })` | `type({ a: ... })` |
| `z.string()` / `z.number()` / `z.boolean()` | `"string"` / `"number"` / `"boolean"` |
| `z.number().int()` | `"number.integer"` |
| `z.literal("x")` | `"'x'"` ；`z.literal(5)` → `"5"` |
| `z.enum(["a","b"])`（静态） | `"'a' | 'b'"` |
| `z.enum(RUNTIME_ARRAY)`（动态） | `type.enumerated(...RUNTIME_ARRAY)`——**不要** `type(arr.join("|"))` |
| `z.array(z.string())` | `"string[]"` |
| `z.array(Item)`（Item 是一个 `type`） | `Item.array()` |
| `z.union([A,B])` | `A.or(B)` 或 `"a | b"` |
| `z.record(z.string(), z.number())` | `type({ "[string]": "number" })`——使用真实的 value type，**不要** `"unknown"`，除非原来是 `z.unknown()` |
| `z.unknown()` / `z.any()` | `"unknown"` |
| `z.null()` | `"null"` |
| `z.nullable(X)` | `X.or("null")` 或 `"X | null"` |
| 字段 `.optional()` | **可选键**：`{ "a?": "string" }`（不是 value method） |
| 字符串长度 `.min(n)` / `.max(n)` | `"string >= n"` / `"string <= n"` / `"1 <= string <= 10"` |
| 数字 `.min/.max/.gt/.lt` | `"number >= n"` / `"number > n"` / `"1 <= number <= 10"` |
| 动态边界（runtime 变量） | 链式方法：`type("string").atLeastLength(1).atMostLength(MAX)`——**不要**用模板字符串 |
| `.describe("d")` | `.describe("d")`（会 emit JSON Schema `description`） |
| `.strict()`（拒绝额外字段） | 加键 `"+": "reject"`：`type({ "+": "reject", ... })` |
| `.strip()`（丢弃额外字段——Zod 默认） | 加键 `"+": "delete"` |
| `.passthrough()` / `.loose()` | 直接删掉（ArkType 默认保留未声明键） |
| `.refine(fn, msg)` | `.narrow((d, ctx) => fn(d) || ctx.mustBe("<expectation>"))` |
| `z.infer<typeof S>` | `typeof S.infer` |
| `z.input<typeof S>` | `typeof S.inferIn` |

## 常见陷阱（这些已导致真实问题——请避免）

1. **切勿在可选 `?` 键上放 `.default()`。** Zod 的 `z.X.default(v).optional()` 是**输出可选**（默认值在代码里通过 `??` 应用）→ 翻译成**可选键，无默认值**：`"limit?": "number"`。只有 **不带** `.optional()` 的 `z.X.default(v)`（输出必填）才变成 `field: type("number").default(v)`（键**没有** `?`）。
2. **`.default()` 只能作为对象属性值使用。** 独立的 `type("number = 0")` 会抛错——内联使用（`type({ count: "number = 0" })`）或对非可选键用 `.default()`。
3. **带描述的 literal union 会 emit `anyOf` of `const`，而不是 `enum`。** 这没问题且验证等价；断言语义 wire 属性（`description`、required、`additionalProperties`），不要断言精确的 `enum` vs `anyOf` 形状。
4. **`type()` 需要静态已知的定义。** 运行时拼出的字符串（`type(arr.join("|"))`、`` type(`1 <= string <= ${MAX}`) ``）在 TS 下失败。用 `type.enumerated(...)` / 链式方法代替。
5. **整数范围：** `"1 <= number.integer <= 3600"`（**不要** `"number.integer >= 1 <= 3600"`）。
6. **`$schema` 由 `toJsonSchema()` emit**——为 wire parity 删掉它（`delete raw.$schema`）。

## 使用 schema 校验（替换 `.parse` / `.safeParse`）

ArkType `Type` 是**被调用**来校验的；失败时返回 `ArkErrors` 实例：

```ts
import { type } from "arktype";
const out = schema(value);
if (out instanceof type.errors) {
  // out.summary -> human message; out.map(e => `${e.path}: ${e.message}`)
  throw new Error(out.summary);
}
// 否则 `out` 是经过校验/变形后的值
```

- `.parse(x)` → `const out = schema(x); if (out instanceof type.errors) throw new Error(out.summary); use out;`
- `.safeParse(x).success` → `!(schema(x) instanceof type.errors)`
- **不要**用 `.allows()` 做工具校验——它会跳过 morphs/defaults/narrows。
- `.infer`（输出）与 `.inferIn`（输入）是仅推断属性（无 runtime value）。

## 高级

### Scopes（可复用别名 / 相互引用 schema）

用 scope 替换一组交叉引用的 Zod schema，然后 `.export()` 到模块：

```ts
import { scope } from "arktype";
const myScope = scope({
  inner: { id: "string" },
  outer: { inner: "inner", tags: "string[]" },
});
const m = myScope.export();        // Module — m.outer, m.inner are Type instances
```

使用 `.export()`——**不要**用 `.compile()`（Scope 上没有这个方法）。

### Morphs / transforms（替换 `.transform()`）

```ts
const n = type("string").pipe(s => Number.parseInt(s));   // 先校验再变形
const o = type("string").to("number.integer");            // .to(def) == .pipe(type(def))
```

### narrow（跨字段 / 后校验谓词，替换 `.refine`）

`narrow` 在**所有校验器/morph 之后**运行（输出侧）。`ctx.mustBe("<expectation>")` 返回 `false` 并记录 `must be <expectation>`：

```ts
type({ action: "string", "body?": "string" })
  .narrow((p, ctx) => p.action === "delete" || p.body !== undefined || ctx.mustBe("a body unless deleting"));
```

### 健壮解析（替换 Zod `.catch(fallback)`）

ArkType **没有内置 `.catch()`**。要实现“解析，否则回退”，把不安全的工作包进 morph：

```ts
const resilient = type("unknown").pipe(raw => {
  const out = innerSchema(raw);
  return out instanceof type.errors ? FALLBACK : out;   // never throws
});
```

对于“缺失 → 默认值”，使用 `=` 默认语法（`"number = 5"`）。如果解析器严重依赖对不可信外部 payload 的每字段 `.catch()`，且 morph 重写变得笨重，该文件可以**保留 Zod**（外部边界例外）——在报告中注明。

### 默认值概览

- `type({ count: "number = 0", flag: "boolean = false" })`——内联、输出必填、wire `default`。
- `type({ x: type("number").describe("d").default(0) })`——**非可选**键上的 `.default()`，当你同时需要 `.describe()` 时使用。

## 完成一个文件后

- 将 `import { z } from "zod/v4"` 替换为 `import { type } from "arktype"`（如果仍在使用 `z` 则保留）。
- 精确保留每个 `.describe()` 字符串和字段可选性。
- 转换文件中的每个 `.parse`/`.safeParse` 调用点。
- **不要**运行 build/test/lint/format——编排器在最后统一运行门禁。
- 报告：变更的文件、任何 `.strict`→`"+"`、`.refine`→`.narrow`、`.catch`→morph，以及任何**有意保留 Zod**的文件（并说明原因）。
