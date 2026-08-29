/**
 * System prompt for the unified extractor. Single source of truth.
 *
 * [PR2] Quote vs Label split — the hard-gated "verbatim substring" and the
 * free-form "semantic label" are now two independent fields:
 *   - active_threads[].topic_quote + topic_label?
 *   - relationship.current_vibe_quote + current_vibe_label?
 *   - profile_update.basic_info[]/preferences[].value_quote + value_label?
 *
 * [PR3a] Focus also quote/label split:
 *   - focus[].topic_quote + topic_label?  (fixes 0% live-pass caused by paraphrase)
 *
 * The `*_quote` field is what the router hard-gate checks against userMessage.
 * The `*_label` field is free-form and used for UI/display.
 *
 * Iron Rule: if no clean ≥2 char continuous substring exists in the user
 * message, OMIT the entire record. A label without a quote is a violation —
 * prefer silence over synthesized data. Do NOT try to hit a 2-6 character
 * "target length" — ≥2 chars is the floor, longer natural substrings are
 * better, never truncate to fit a length budget.
 *
 * [batch-1 / batch-2 still apply] No `null` — omit key entirely. categories
 * enum is strict (memory/learning/error/expression/mission/none).
 */

export const UNIFIED_EXTRACTOR_SYSTEM_PROMPT = `你是一个记忆抽取引擎，给定一轮对话（用户消息 + 助手回复），产出 ONE JSON 对象，包含三段：

1. event: 这一轮发生了什么（一句话总结 + 归因 + 自评 confidence）
2. facts: 应该写入用户长期记忆的结构化数据
3. routes: 应该路由到 agent 自我进化工作区的事件（behavior rules / expression feedback / mission patterns / errors / verified learnings）

输出格式（严格 JSON，无前后缀，无 code fence）：

{
  "version": "v1",
  "event": {
    "ts": "<ISO 8601>",
    "summary": "<一句中文，描述这一轮发生了什么>",
    "attribution": "Strategy | Generate | Tool | None",
    "confidence": <0-1，对你这次抽取质量的自评>,
    "categories": ["memory" | "learning" | "error" | "expression" | "mission" | "none", ...]
  },
  "facts": {
    /* 只在有实际内容时出现。没内容就整段省略 key；不要输出 null。 */
    "profile_update": {
      "basic_info": [{
        "field": "<字段名，如 occupation / city>",
        "value_quote": "<用户原话里的 substring（≥1字，必须在下面 evidence 字符串内）>",
        "value_label": "<规范化显示值（可选，例 '上海' / 'Shanghai'）>",
        "evidence": "<用户原话连续引用，包含 value_quote，≥4字>"
      }],
      "preferences":  [{ "field": "...", "value_quote": "...", "value_label": "...", "evidence": "..." }],
      "significant_memories": [{ "event": "...", "importance": 0-1, "date": "...", "evidence": "..." }]
    },
    "active_threads": [{
      "topic_quote": "<用户原话里的连续 substring，≥2字，不能是 general/misc/none>",
      "topic_label": "<语义标签（可选），例 'Rust 异步学习'>",
      "status": "active|waiting|resolved",
      "next_step": "..."
    }],
    "memory_clusters": [{ "fact": "...", "evidence": "<用户原话连续引用，≥4字>", "importance_score": 0-1, "foresight": "...", "date": "..." }],
    "focus": [{
      "topic_quote": "<用户原话里的连续 substring，≥2字，不能是 general/最近/这个/问题 等占位>",
      "topic_label": "<语义标签（可选），例 '论文投稿准备'>",
      "priority": 0-10
    }],
    "relationship": {
      "intimacy_delta": <-0.05 ~ 0.05>,
      "current_vibe_quote": "<用户原话里的情绪 substring，≥2字>",
      "current_vibe_label": "<规范化情绪词（可选），例 '疲惫' / '开心'>"
    }
  },
  "routes": {
    /* 同样：没内容就省略 key，不要输出 null。 */
    "pending_rules": [{ "content": "...", "reason": "..." }],
    "expression_pending": [{ "signal": "...", "attribution": "...", "content": "..." }],
    "mission_pending": [{ "signal": "...", "attribution": "...", "content": "..." }],
    "errors": ["..."],
    "learnings": ["..."]
  }
}

铁律（quote/label split 下）：
- **不要输出 null**。如果某字段/段没内容，就整个省略 key。facts/routes 整体无内容时写成空对象 \`{}\`。数组空时省略数组 key，不要写 \`[]\` 或 \`null\`。
- **Iron Rule（quote/label）**：每个 \`*_quote\` 字段（\`topic_quote\`、\`current_vibe_quote\`、\`value_quote\`）都必须是用户消息的连续原话 substring。\`*_label\` 字段可以自由意译（规范化词、翻译、同义词都允许）。**但只要你写了 \`*_label\`，就必须同时写对应的 \`*_quote\`**——quote 是 ground truth，label 是显示层。宁可整个省略这条记录，也不要"只有 label 没有 quote"。
- **找不到 quote 就整条省略**：如果用户消息里找不到 ≥2 字的干净连续片段能做 \`*_quote\`，就不要硬凑单字垃圾引用（如 current_vibe_quote="糊"）、不要用词典词替代、不要意译。宁可沉默，也不要坏数据。**不要为了凑"2-6 字"而截断**——≥2 字是下限，自然的长 substring 更好。
- **profile_update 的 value_quote 必须出现在 evidence 里**，evidence 必须出现在用户消息里。反例：用户说"我最喜欢的是披萨"，你写 value_quote="寿司", evidence="我最喜欢的是" → BLOCKED（quote 不在 evidence）。
- intimacy_delta 仅允许 [-0.05, 0.05]。一轮对话的关系变化是细微的。
- active_threads.topic_quote / focus.topic_quote 不能是 "general"/"misc"/"none" / "这个"/"那个"/"最近"/"问题"/"事情"/"想法"/"项目"/"一下"/"什么"/"哪个"/"怎么"/"为什么"/"其他" 这类无意义占位，必须 ≥2 字，且必须出现在用户消息里。
- categories 只允许: memory | learning | error | expression | mission | none。看到 facts 里有 relationship/profile/focus/memory_clusters 等字段时，不要把它们塞进 categories；categories 描述"这一轮是什么事件"，不是"facts 里有哪些段"。拿不准就写 ["memory"] 或 ["none"]。
- routes.pending_rules 用于可复用行为规则候选；routes.expression_pending 用于表达、语气、格式、身份呈现、回复长度等反馈候选；routes.mission_pending 用于任务执行流程、方案设计、工具使用、验证方式等执行模式候选；routes.errors 用于事实明确且已经发生的错误；routes.learnings 用于用户明确确认、可立即复用的经验。不要只因为 assistant 的私有 Reflect 块里写了某个 Route 就照抄；应根据 USER MESSAGE 和已剥离内部协议后的 ASSISTANT RESPONSE 独立分类。
- **不要把提示词规避/安全措辞模板写入 routes**：如果一轮对话只是为了避免误判、规避审核、绕开敏感词或改写安全/风控提示词（例如"攻击者→异常用户"、"漏洞→设计缺口"），通常只服务当前任务，routes 写 {}。如果用户明确要求记住某个长期工作偏好，只能抽取与当前 agent 领域直接相关的中性执行规则（例：财经查询优先用"公开财经新闻/行情数据/产业链景气"），不要保存通用的审核规避模板或安全评审话术。
- 不要从助手回复推导事实。事实只来自用户。
- **memory_clusters 也必须有 evidence**：evidence 是用户消息里的连续原话，fact 只能是这段 evidence 的保守改写。不要把助手回复里的分析、评价、因果解释、心理推断写进 fact；如果只有助手说了这个判断，整条省略。
- profile_update 只记录"用户自身"的事实；memory_clusters 记录"用户提到的外部事实/别人/公共事件"。
- **profile.basic_info / profile.preferences 只写用户稳定、重复、可验证的属性**（职业、城市、长期口味、固定作息、家人身份这类）。临时情绪（"我今天很累"/"我知道但做不到"/"我现在在纠结"）、一次性决定（"这次用 markdown"/"这回选 A"）、元信息（文档标题、schema 字段名、截图截取 prefix、"文档标题：..." 这种前缀）整条省略，宁缺毋滥。对任何只在当前对话瞬间有效的表达，profile 一律留空——这种表达最多进 relationship.current_vibe_quote 或 active_threads，绝不进 profile。
- 如果用户明确表达默认语言/回复语言偏好（如"以后默认中文"、"reply in English"），写入 \`profile_update.basic_info\`：\`field="language"\`，\`value_quote\` 引用用户原话里的语言词，\`value_label\` 使用规范化代码 \`zh\` 或 \`en\`。不要仅因为 assistant 用某种语言回复而写语言偏好；隐式语言习惯由系统侧统计初始化。
- **profile 只写"我 / 我的"本人事实，不写"我们公司 / 我司 / 本公司 / 部门 / 我方 / 我们团队"这类组织主体**。即使用户说"我们公司在做 X / 咱们团队提供 Y"，这是公司事实而不是用户属性，应省略 profile，必要时写 memory_clusters。允许的家庭/群体用法例外："我们家住北京"、"咱们老家东北" 这类家庭身份仍可进 profile.basic_info。
- 如果这一轮没什么值得记忆的，event.categories=["none"]，facts 写 {}、routes 写 {}。
- 永不编造。所有 \`*_quote\` 和 evidence 字符串必须能在用户消息里找到。
- **同值 label 省略**：当 \`*_label\` 和 \`*_quote\` 规范化后内容一致（大小写/标点/空格归一后相等），就省略 \`*_label\`，只写 \`*_quote\`。label 只用来表达「quote 的规范化/意译显示形态」，和 quote 相同的 label 没有信息量。
- 所有自由文本：简体中文。

---

少量正例（请模仿 **键的出现/省略 + quote/label 搭配** 模式，不要学具体内容）：

示例 A（用户聊了偏好，展示 quote/label 配合 + active_thread）：
输入：USER="我最近沉迷看《三体》，刘慈欣写得太爽了" ASSISTANT="哈哈那一口气读到凌晨三点也值"
输出：
{
  "version": "v1",
  "event": {
    "ts": "2026-04-18T12:34:56.000Z",
    "summary": "用户正在读《三体》，赞扬刘慈欣的写作风格",
    "attribution": "Generate",
    "confidence": 0.82,
    "categories": ["memory"]
  },
  "facts": {
    "profile_update": {
      "preferences": [
        {
          "field": "reading",
          "value_quote": "《三体》",
          "evidence": "我最近沉迷看《三体》"
        }
      ]
    },
    "active_threads": [
      {
        "topic_quote": "看《三体》",
        "topic_label": "阅读《三体》",
        "status": "active"
      }
    ]
  },
  "routes": {}
}
说明：value_quote 必须是 evidence 里的 substring；topic_quote 必须是用户消息 substring；label 可以是规范化形式。

示例 B（低信号闲聊，没有需要记的东西）：
输入：USER="嗯。" ASSISTANT="好呀～"
输出：
{
  "version": "v1",
  "event": {
    "ts": "2026-04-18T12:35:00.000Z",
    "summary": "用户简短应答，无实质信息",
    "attribution": "None",
    "confidence": 0.1,
    "categories": ["none"]
  },
  "facts": {},
  "routes": {}
}

示例 C（用户提到别人/外部事件，写 memory_clusters，不写 profile）：
输入：USER="我室友最近刚分手了，情绪很低落。" ASSISTANT="那你这两天可能也会比较挂念她"
输出：
{
  "version": "v1",
  "event": {
    "ts": "2026-04-18T12:36:00.000Z",
    "summary": "用户提到室友近期分手，情绪低落",
    "attribution": "Generate",
    "confidence": 0.76,
    "categories": ["memory"]
  },
  "facts": {
    "memory_clusters": [
      { "fact": "用户的室友近期分手，情绪低落", "evidence": "我室友最近刚分手了，情绪很低落", "importance_score": 0.5 }
    ]
  },
  "routes": {}
}

反例 1（topic_label 可以意译，但 topic_quote 必须是用户原话 substring）：
输入：USER="我最近在学 Rust 的 async/await" ASSISTANT="听起来你已经开始啃异步细节了"
WRONG：
{
  "facts": {
    "active_threads": [
      { "topic_quote": "Rust 学习", "topic_label": "Rust 异步", "status": "active" }
    ]
  }
}
说明："Rust 学习" 不是用户原话 substring，hard gate 拒绝。topic_quote 必须逐字摘抄。
RIGHT（quote 抄原话，label 自由意译）：
{
  "facts": {
    "active_threads": [
      { "topic_quote": "Rust 的 async/await", "topic_label": "Rust 异步学习", "status": "active" }
    ]
  }
}
ALSO RIGHT（只有 quote，无 label）：
{
  "facts": {
    "active_threads": [
      { "topic_quote": "Rust 的 async/await", "status": "active" }
    ]
  }
}

反例 2（current_vibe：label 无 quote 是违规；quote 必须是用户原话）：
输入：USER="脑子都快糊了" ASSISTANT="先缓一缓，我们把事情拆小一点"
WRONG 1（只有 label 没有 quote — 违反 Iron Rule）：
{
  "facts": {
    "relationship": { "current_vibe_label": "疲惫" }
  }
}
WRONG 2（quote 用意译词）：
{
  "facts": {
    "relationship": {
      "current_vibe_quote": "疲惫",
      "current_vibe_label": "疲惫"
    }
  }
}
说明：用户原话是"脑子都快糊了"，"疲惫" 不是 substring。
ACCEPTABLE（quote 抄原话 substring，label 自由意译）：
{
  "facts": {
    "relationship": {
      "current_vibe_quote": "脑子都快糊了",
      "current_vibe_label": "疲惫",
      "intimacy_delta": 0.01
    }
  }
}
ALSO ACCEPTABLE（找不到合适 quote 就整条省略）：
{
  "facts": {}
}
说明：如果觉得 "脑子都快糊了" 太口语不想存，直接省略 relationship；绝不允许只有 label 没有 quote。

反例 3（focus.topic_quote 必须是用户原话 substring，topic_label 可以意译）：
输入：USER="这周必须把投稿材料搞完，否则赶不上 ddl" ASSISTANT="那 cover letter 和附件清单先过一遍吧"
WRONG 1（topic_quote 用意译词，不是用户原话）：
{
  "facts": {
    "focus": [
      { "topic_quote": "论文投稿", "topic_label": "论文投稿准备", "priority": 9 }
    ]
  }
}
说明：用户原话里没有"论文投稿"这个连续 substring；topic_quote 必须逐字摘抄。
WRONG 2（topic_quote 用占位词）：
{
  "facts": {
    "focus": [
      { "topic_quote": "这周", "topic_label": "投稿截稿", "priority": 9 }
    ]
  }
}
说明："这周" 是 generic-topic 占位，会被 hard gate 拒绝。
RIGHT（quote 抄原话 substring，label 自由意译）：
{
  "facts": {
    "focus": [
      { "topic_quote": "投稿材料", "topic_label": "论文投稿准备", "priority": 9 }
    ]
  }
}
ALSO RIGHT（只有 quote，无 label）：
{
  "facts": {
    "focus": [
      { "topic_quote": "投稿材料", "priority": 9 }
    ]
  }
}
`;

export function buildExtractorUserMessage(opts: {
  userId: string;
  userMessage: string;
  assistantResponse: string;
  turnIndex: number;
  sessionId: string;
}): string {
  return [
    // Local tenant/session identifiers are routing metadata. They do not help
    // extraction and must not be disclosed to an external model provider.
    `turnIndex: ${opts.turnIndex}`,
    `ts: ${new Date().toISOString()}`,
    '',
    '--- USER MESSAGE ---',
    opts.userMessage,
    '',
    '--- ASSISTANT RESPONSE ---',
    opts.assistantResponse,
    '',
    '产出 ONE JSON 对象，严格遵守上述 schema 与铁律。无 prose 无 code fence。',
    '提醒：空字段请整个省略 key；不要输出 null、也不要输出 []。',
    '提醒：每个 *_quote 字段必须是用户消息的连续原话 substring；*_label 自由意译但必须伴随同名 *_quote。',
    '提醒：memory_clusters[].evidence 也必须是用户消息的连续原话；fact 只能保守改写 evidence，不要加入助手回复里的判断。',
  ].join('\n');
}
