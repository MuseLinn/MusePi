# 语音听写流式落地：交接说明

> 写给接手的新会话。这份文档记录**当前代码的真实状态**、**已确认的缺陷**、**我踩过的弯路**，以及建议的处理方向。请以代码为准核对，不要只信本文。

## 1. 一句话背景

用户要求「说话时字就出现」的流式听写。功能已实现，但连续迭代引入了多个回归：字重复、动效看不到、长句不落稿、偶发白屏。用户明确提出：**放弃动效，优先保证功能正确**。

## 2. 当前涉及的文件

| 文件 | 职责 |
| --- | --- |
| `packages/client-core/src/components/composer/dictation-splice.ts` | 纯函数：`dictationSplice`（区间重写）、`mergeDictationFinal`（最终结果合并） |
| `packages/client-core/src/components/composer/ComposerEditor.tsx` | `writeDictation` / `commitDictation` / `cancelDictation` 三个句柄方法 |
| `packages/client-core/src/components/composer/composer-editor-code.ts` | `dictationField`（装饰区间）、`dictationWrite`（事务标注） |
| `apps/desktop/src/components/composer/use-dictation.ts` | 听写状态机：`spoken.committed` + `spoken.hypothesis` |
| `apps/desktop/src/lib/voice.ts` | `startDictationOpts`，前端事件源 |
| `packages/coding-agent/src/voice/frontend/client.ts` | 语音前端流，产出 partial / segment |
| `packages/coding-agent/src/stt/asr-worker.ts` | ASR worker，`stream_audio` / `stream_utterance` / `stream_preview` |

## 3. 架构现状（理解缺陷的前提）

一次听写的文字经过两层：

```
麦克风 → voice.ts → frontend/client.ts → asr-worker
                                            ├─ onPartial（生长中的句子）→ spoken.hypothesis
                                            └─ onSegment（定稿句）      → spoken.committed
                                                    ↓
                            writeDictation(committed, hypothesis, restart)
                                    ↓ 替换文档中「听写区间」那一段
                            dictationSplice(冻结原文, start, end, committed + hypothesis)
```

关键不变量（**必须保持**）：
- `dictationRef`（冻结原文 + 光标）只在一次听写内有效，`commitDictation` / `cancelDictation` / 用户外部编辑都会清空它。
- 文档里的文字就是草稿真身（不是 ghost），所以取消必须精确回滚。

## 4. 已确认的缺陷（按严重度）

### 4.1 第一个字重复（用户最新反馈，未修）

**症状**：说第一个字后，第一个字出现两次。

> **最先查这一条**：`onSegment` 里的拼接 `committed = committed + text` 是无条件的，
> 而 `finish()` 里已经用 `mergeDictationFinal` 处理了"识别器可能返回整段"的形态。两条路不一致——
> 如果识别器对同一个定稿句既发 segment 又在 final 里带上它，就会重复。修法：让 `onSegment` 也走
> `mergeDictationFinal`。这是我在只读代码、未上真机的情况下能找到的最可疑点。

**我验证过、并且已排除的两条假设**（都写成了探针跑过，别重复劳动）：

| 假设 | 结果 |
| --- | --- |
| `writeDictation` 改文档 → `onChange` → 父层回写**同一个值** | 未复现。`useEffect([value])` 里有 `current === value` 去重，不会重复写。 |
| 父层回写**旧值**（pre-dictation）→ 文档被改回 → 下一个 partial 再写一次 | 未复现。回写后文档回到 `""`，但 `dictationRef` 未被清（回写打了 `valuePropWrite`，不是 `dictationWrite`，会走 `!ours` 分支清锚点），下一个 partial 因锚点已清直接 `return`。**注意：这里的行为是"丢字"而不是"重复"** —— 如果真机上看到的是"第一个字重复"，说明真实时序与我的探针不同。 |

**仍然值得优先查的地方**：

1. `restart` 的语义混淆（见 §5.5）。`write()` 里 `!started` 只在第一次为 true。若**第一次写入时 `spoken.hypothesis` 为空**（例如先收到一个 segment），`origin` 会冻结在"文档已含该字"的状态；随后 partial 到来时用同一 `origin` 重算，理论上不重复，但 `started` 一旦为 true 就再也不会重冻结——若这期间文档被外部改过，`dictationSplice` 用的是**旧 origin** 而 `replaceFrom/To` 用的是**新文档的区间**，两者不一致时可能产生残影。
2. **`onSegment` 的累加**（见开头的重点提示）。

**建议的验证手段**：在 `onSegment` 与 `write()` 各打一条临时日志（或加断言测试），确认同一个字是否被投递两次。这比继续改代码猜要快。

### 4.2 长句不落稿

**症状**：说的话较长时，停止后文字停在那里、不进入"已落稿"状态（视觉上仍是弱化色或位置不对）。

**已知相关代码**：`finish()` 只在 `finalText` 非空时写入并 `commitDictation()`。`onFinal` 的 `transcript` 来自 `voice.ts` 的 `stop()` 聚合结果；长句会触发前端 endpointer 的 `maxSegmentMs`（12s）强制切句，切出来的多段在 `stop()` 时被 join。若其中某段 `state === "uncertain"`，走的是 `onReview` 而非 `onFinal`，**不提交也不再写入**，于是停在预览态。

**待验证**：长句时是否走了 `onReview`（说话人校验是否开启）。这是用户设置相关，不是纯代码 bug，但体验上不该"卡住"。

### 4.3 动效看不到（已按用户决定删除）

用户决定不再做动效。已删除 `dictationTailEffect()`、`advanceTail` 导入，以及 `dictation-preview.tsx` 里对 `.tr-char` 的过时断言。**注意**：`dictationField` 只做 mark 装饰（弱化颜色），不生成逐字 span，所以从代码上动效从来没有真正生效过——之前"看不到"是事实而非 bug。

### 4.5 占位符与听写文字重叠（本轮已修，记录教训）

改为"文字真身进文档"之后，`setPreviewing` 这个标志没人再设为 true，于是 `!previewing` 恒真、占位提示永远显示，和听写文字叠在一起。已改为跟踪**视图文档是否为空**（`docEmpty` state，在 update listener 与三个句柄方法里同步）。教训：**删掉一条写入通道时，要一并检查依赖它状态的 UI 判据。**

### 4.4 偶发白屏（已修，但请确认）

`Invalid change range 4 to 9 (in doc of length 5)`：冻结区间在文档被整段替换后仍被 dispatch。已加边界校验（越界即放弃写入），并有 5 项回归测试。

## 5. 我踩过的弯路（别再走一遍）

1. **把"未接线的样式"误判为缺陷**。`.gui-composer-ico--dictating` 的胶囊样式是 `fe275c7f7` 做过、后被**明确推翻**的方案（文档 §5n：「30px capsule is a motion budget, not a copy budget」）。我误以为"契约没接上"又加回去，被用户当场指出。**改 UI 前先 `git log -S` 查这段是不是被刻意弃用的。**
2. **用整篇文档替换做增量写入**。第一版 `from: 0, to: doc.length`，导致逐字动效对全篇重放、光标乱跳。后改为只替换区间。
3. **预览用 ghost widget**。第一版把预览画成装饰 widget（不进文档），与"落稿追加到末尾"脱节，导致句序错乱。后改为文字真身进文档。
4. **取消时删区间而非恢复原文**。会产生 `beforeafter`（吃掉分隔空格）。
5. **`restart` 语义不清**。它同时承担"冻结锚点"和"第一次写入"两个含义，是 4.1 类缺陷的温床。

## 6. 建议处理顺序

1. **先关掉动效**（删 `dictationTailEffect` + 过时断言），减少变量。
2. **修 4.1 重复**：确认 `writeDictation` 的事务是否应改打 `valuePropWrite`，或让外部回写逻辑识别听写区间；加一条"同一个字不会出现两次"的回归测试。
3. **修 4.2 落稿**：`onReview` 也应该落地文字（只是不自动发送），并 `commitDictation()`；补长句场景测试。
4. **回归验证**：用 `apps/desktop/scripts/gui-probe-scenarios/dictation-live.tsx` 做视觉验证（注意它当前依赖已失效的 `.tr-char`）。
5. **最后**再考虑是否需要动效。

## 7. 现有测试与验证命令

```bash
# 区间语义与合并逻辑
cd packages/client-core && bun test src/components/composer/

# 崩溃回归
bun test src/components/composer/composer-dictation-safety.test.tsx

# 桌面端听写链路
cd apps/desktop && bun test test/voice-streaming-dictation.test.ts test/voice-status-strip.test.tsx

# 视觉验证（会启动 Chromium）
rtk bun apps/desktop/scripts/gui-probe.ts apps/desktop/scripts/gui-probe-scenarios/dictation-live.tsx
```

注意：`apps/desktop` 有 4 个**既有**类型错误（`gui-probe-scenarios/*`、`quote-cards.tsx`），与听写无关，不要花时间修。

## 8. 工作区状态提醒

`git status` 里 `app.tsx`、`AppRail.tsx`、`InstanceButton.tsx`、`gui-chrome.css`、`tool-views.generated.js` 等属于**另一个会话的侧栏工作**，不要碰、不要纳入提交。听写相关改动已提交在 `89e3e5b53` 及其之前几个提交。

## 9. 用户可复现的反馈（原文）

- 连续点击输入几次后出现白屏（`Invalid change range 4 to 9`）
- 停止后显示的还是预览文字
- 有文本时语音不能落稿
- 第一个字会重复
- 动效看不到
- 长句不能落稿
