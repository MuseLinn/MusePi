# 嵌入式本地 Tiny-Model 实验


[English](local-models.md) | 中文
本文档总结了可选 **local** tiny-model 路径背后的实验，涵盖会话标题生成（`providers.tinyModel`）、Mnemopi 记忆提取/整合（`providers.memoryModel`），以及 `auto` 思维层级难度分类器（`providers.autoThinkingModel`，复用 memory-model registry）。这是一份面向 maintainer 的事实性工程记录：我们测了什么、哪些方案胜出、哪些模型被 shipped。这三项设置均默认 `online`，因此现有用户在主动 opt in 之前不会产生任何下载或端侧推理成本。

## Runtime / 环境发现

- **Stack**：`@huggingface/transformers`（transformers.js）v4 运行于 Bun。在 Bun 中该库加载**原生 `onnxruntime-node` backend**（非 WASM build）。
- **Device policy**：local tiny models 默认 CPU-only inference；若显式加速 provider 初始化失败则会在 CPU 上重试一次。
  - 可通过 `providers.tinyModelDevice` 设置持久选择 provider（`default` 保持 CPU），或通过 `PI_TINY_DEVICE` env var 单次覆盖（优先级高于设置）。
  - 可接受值：`cpu`、`gpu`、`metal`/`webgpu`、`auto`、`cuda`、`dml`、`coreml`、`wasm`、`webnn`、`webnn-gpu`、`webnn-cpu`、`webnn-npu`。
  - 直接使用 `coreml` 仍通过 `PI_TINY_DEVICE=coreml` opt in；它未进入默认策略，因为缓存的 decoder-LLM ONNX 在 session initialization 期间可能加载失败。
  - WebGPU/Metal 在单进程 eval harness 中可用，但 production worker 会强制把 Darwin 上的 `gpu`/`webgpu`/`auto` 请求回退到 CPU，因为 ONNX Runtime/Bun 在 WebGPU inference 后的 worker teardown 时会 hard-crash。
  - 仅在显式选择退出 CPU 默认时才使用 `providers.tinyModelDevice` 或 `PI_TINY_DEVICE`。
- **Quantization: q4 是甜点**——磁盘体积更小、加载更快、inference 也快。q8/int8 加载更慢**且**在 CPU 上 inference 更慢。所有 shipped model 均默认 `q4`；可通过 `providers.tinyModelDtype` 设置持久覆盖精度（`default` 保持 `q4`，例如 `fp16` 追求更高保真），或通过 `PI_TINY_DTYPE` 单次覆盖（优先级高于设置）。接受 `auto`、`fp32`、`fp16`、`q8`、`int8`、`uint8`、`q4`、`bnb4`、`q4f16`、`q2`、`q2f16`、`q1`、`q1f16`；未识别的值会在 worker startup 时报错失败。
- **Load-time 修正（重要）**。早先认为“q4 >=1B 模型需要数分钟加载”的说法是**测量假象**，由并行运行约 5 个多 GB HuggingFace 下载导致（I/O saturation）。干净、孤立的**warm** 加载均在 3 秒以内：
  - TinyLlama-1.1B q4：约 0.5s
  - Llama-3.2-1B q4：约 2.8s（`graphOpt=all`）/ 约 0.5s（`disabled`）
  - LFM2-1.2B q4：约 0.36s
  - Qwen2.5-1.5B q4：约 1.5s
  - Qwen3-1.7B q4：约 1.6s
  - gemma-3-1b q4：约 1.1s
  - 结论：**1B–1.7B 模型在 CPU 上可行。**
- **`session_options.graphOptimizationLevel`** 在 load 与 inference speed 之间取舍：`disabled` = 加载最快、inference 略慢；`all` = 默认。
- **First run** 从 HF Hub 下载权重到 cache dir（q4 权重约 200MB–1.1GB，因模型而异）；后续**warm** 加载为亚秒到约 3 秒。Inference 为 async 且对 memory 任务 background-friendly；标题生成是半交互式。

## Task 1：会话标题生成（`providers.tinyModel`）

**任务**：把首条用户消息转为 3–6 词标题。Tiny 模型（sub-1B）足够胜任。

**胜出 recipe**：

- 纯 system prompt（无 few-shot）。
- 在 assistant turn 中用 `<title>` **prefill** 并**在 `</title>` 处 stop**，然后取首行。
- Greedy decoding（`do_sample:false`），chat template 中 `enable_thinking:false`。

**经验**：

- **Few-shot examples 伤害 sub-0.6B 模型**生成标题；tag-prefill 能挽救 270M 模型。
- **Token biasing（`bad_words_ids`）在此是确认的 no-op**——prefill 已经控制开头。

**Leaderboard**（tag trick，CPU，warm）：

| 模型 | 结论 |
| --- | --- |
| LFM2-350M | 速度/质量平衡最佳（约 212MB） |
| Qwen3-0.6B | 最鲁棒 |
| gemma-3-270m | 最小可用 |
| Qwen2.5-0.5B | 可接受 |
| SmolLM2-135M | 太小 |
| flan-t5-small | 被拒绝——只是复述输入 |

**已发货 local 选项**：`lfm2-350m`、`qwen3-0.6b`、`gemma-270m`、`qwen2.5-0.5b`、`lfm2-700m`。
**默认**：`online`（`@smol`）。

## Task 2：Mnemopi memory（`providers.memoryModel`）

Mnemopi 运行两个 small-LLM 任务：

1. **Extraction**——从单条消息中提取 durable、structured items。
2. **Consolidation**——把一组 memory 整合为 1–3 句忠实摘要。

这两个任务需要的模型比标题**更大：1B–1.7B**。我们测试了 LFM2-1.2B、Qwen2.5-1.5B、Qwen3-1.7B 和 gemma-3-1b（q4，CPU），每组通过四个并行 agent 运行 27–31 个实验。

### Extraction 发现

Stock 5 类 JSON prompt 在小模型上以两种方式失败：

1. 全空示例 `{"facts":[],...}` 被**逐字复制** → 提取 0 条 facts。
2. 部分模型在数组中输出**JSON objects**，被 Mnemopi 的 `String(item)` 强制转为字面量字符串 `[object Object]`。

稳健修复是采用**每行一条输出格式**（被 Mnemopi parser 的 line-fallback 消费）或**flat JSON array of strings**。每个模型都会过度提取纯 small talk；显式的 chit-chat → NONE 示例是最佳缓解。

### 与标题任务的 Technique polarity 翻转

- 在 1B+ 规模，**few-shot 是主导质量杠杆**：例如 Qwen2.5-1.5B extraction F1 从 0.52 → 0.83（1-shot 到 3-shot）；gemma recall 从 0.65 → 0.92（2-shot）。
- **Prefill 伤害 extraction**——它强制小 talking 输出，产生 false positives。
- **System-split**（指令放在 system role）对具备 system role 的模型有帮助。
- **Greedy >= temperature**适用于两个任务。
- **Token biasing** 同样是 no-op。

### 各模型 verdict（head-to-head，16-fixture set）

- **Qwen3-1.7B**——最守纪律的 extraction：small talk 返回空、无 buried-fact leak、保留语言、输出 clean flat JSON。弱点：粒度粗、漏掉 multi-turn value update。
- **Qwen2.5-1.5B**——最佳 extraction 粒度（atomic facts）、catch 住 value update、零 small-talk leakage。弱点：consolidation 最弱（run-on、无 dedup）且一次 degenerate buried-fact 输出。
- **gemma-3-1b**——最佳 consolidation（dedup 工作、faithful、clean single-memory）。弱点：leak small talk 和翻译后的德语。
- **LFM2-1.2B**——solid 且加载最快。弱点：`Label: value` 噪声、small talk + buried leaks、fluffy single-memory summary。

### 建议

Extraction 偏向**精度**（不污染长期 memory）→ **Qwen3-1.7B 是最佳单 pick**（其 consolidation 足够好）。若为 consolidation 运行第二个模型，**gemma-3-1b** 赢该任务。

**已发货 local 选项**：`llama3.2:3b`、`qwen3-1.7b`（推荐）、`gemma-3-1b`、`qwen2.5-1.5b`、`lfm2-1.2b`。
**默认**：`online`（使用已配置的 smol 模型）。

### 已知 Mnemopi parser bugs（经这些实验暴露）

- `String(item)` 对 object array items 产生 `[object Object]`。
- line-fallback 会丢弃长度 `<=10` 的 items，因此正确的短 fact（如 `Name: Can`）会被丢弃。


## Integration notes

- `providers.tinyModel`、`providers.memoryModel` 和 `providers.autoThinkingModel` 均默认 `online`，因此现有用户在主动 opt in 之前不会产生任何下载或端侧推理成本。
- Local inference 运行在 **worker** 内（脱离主线程）；模型被缓存到磁盘并在首次使用时下载。
- Memory local path 应用 refined recipes（line-format + small-talk-guarded extraction prompt、hardened consolidation prompt），通过 Mnemopi prompt overrides 实现；**online path 保持不变**。
- `providers.autoThinkingModel` 使用与 `providers.memoryModel` 相同的 shipped local options。
