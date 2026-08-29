// tests/unified-memory/thresholds.test.ts
import {
  DEFAULT_THRESHOLDS, mergeThresholds, passesConfidenceGate, passesHardGate, evaluateHardGate,
} from '../../src/agent/memory/unified/thresholds';

let passed = 0, failed = 0;
function assert(c: boolean, l: string): void { if (c) { console.log(`  ✅ ${l}`); passed++; } else { console.log(`  ❌ ${l}`); failed++; } }

console.log('--- Test 1: Codex-calibrated defaults ---');
{
  assert(DEFAULT_THRESHOLDS.profile_update === 0.88,  'profile 0.88');
  assert(DEFAULT_THRESHOLDS.relationship === 0.78,    'relationship 0.78');
  assert(DEFAULT_THRESHOLDS.active_threads === 0.62,  'threads 0.62');
  assert(DEFAULT_THRESHOLDS.focus === 0.48,           'focus 0.48');
  assert(DEFAULT_THRESHOLDS.memory_clusters === 0.34, 'clusters 0.34');
}

console.log('--- Test 2: mergeThresholds applies user overrides ---');
{
  const m = mergeThresholds({ profile_update: 0.95, focus: 0.6 });
  assert(m.profile_update === 0.95, 'profile overridden');
  assert(m.focus === 0.6,           'focus overridden');
  assert(m.memory_clusters === 0.34, 'unspecified keeps default');
}

console.log('--- Test 3: confidence gate respects category ---');
{
  const t = DEFAULT_THRESHOLDS;
  assert(passesConfidenceGate(0.9, 'profile_update', t) === true,   '0.9 passes profile (0.88)');
  assert(passesConfidenceGate(0.85, 'profile_update', t) === false, '0.85 fails profile');
  assert(passesConfidenceGate(0.4, 'memory_clusters', t) === true,  '0.4 passes clusters (0.34)');
}

console.log('--- Test 4 [PR2]: hard gate — codex reproduction case (BLOCKED) ---');
{
  // value_quote = fabricated value '寿司', not present in evidence → BLOCKED
  const userMsg = '我最喜欢的是披萨';
  const fab = passesHardGate('profile_update',
    { field: 'preference', value_quote: '寿司', value_label: '寿司', evidence: '我最喜欢的是' },
    { userMessage: userMsg });
  assert(fab === false, 'fabricated value_quote (寿司) blocked even though evidence overlaps user');
}

console.log('--- Test 5 [PR2]: hard gate — value_quote in evidence (PASS) ---');
{
  const userMsg = '我最喜欢的是披萨';
  const ok = passesHardGate('profile_update',
    { field: 'preference', value_quote: '披萨', value_label: '披萨', evidence: '我最喜欢的是披萨' },
    { userMessage: userMsg });
  assert(ok === true, 'value_quote-in-evidence + full substring → pass');

  const blankQuote = evaluateHardGate('profile_update',
    { field: 'preference', value_quote: '   ', value_label: '披萨', evidence: '我最喜欢的是披萨' },
    { userMessage: userMsg });
  assert(blankQuote.ok === false, 'whitespace-only value_quote blocked');
  assert(blankQuote.reason === 'quote-too-short', 'blank value_quote reason classified');
}

console.log('--- Test 6 [P1.1]: hard gate — low entropy evidence (BLOCKED) ---');
{
  const userMsg = '我我我我我我说话的方式';
  const lowEnt = passesHardGate('profile_update',
    { field: 'nickname', value_quote: '我', evidence: '我我我我我我' },
    { userMessage: userMsg });
  assert(lowEnt === false, 'repeated-char evidence blocked');
}

console.log('--- Test 7 [P1.1]: hard gate — full substring required, not sliding ---');
{
  const userMsg = '我叫 Ada，今年 32 岁';
  // Pieces of evidence appear in user but not as one continuous run
  const split = passesHardGate('profile_update',
    { field: 'name', value_quote: 'Ada', evidence: '我叫32岁' },  // chars exist scattered, not as substring
    { userMessage: userMsg });
  assert(split === false, 'non-contiguous evidence blocked');
}

console.log('--- Test 8 [P1.1]: hard gate — evidence < 4 chars rejected ---');
{
  const tooShort = passesHardGate('profile_update',
    { field: 'nickname', value_quote: 'Ada', evidence: 'Ada' },
    { userMessage: '我叫 Ada' });
  assert(tooShort === false, 'evidence < 4 chars blocked');
}

console.log('--- Test 8b: hard gate reason classification is exposed ---');
{
  const res = evaluateHardGate('profile_update',
    { field: 'nickname', value_quote: 'Ada', evidence: 'Ada' },
    { userMessage: '我叫 Ada' });
  assert(res.ok === false, 'short evidence rejected');
  assert(res.reason === 'evidence-too-short', 'reason classified');
}

console.log('--- Test 9 [PR2]: relationship current_vibe_quote must be substring of userMessage ---');
{
  // Meta-quote '柔软' fabricated, not in userMessage → BLOCKED
  const userMsg = '今天天气不错';
  const bad = passesHardGate('relationship',
    { current_vibe_quote: '柔软' },
    { userMessage: userMsg });
  assert(bad === false, 'relationship vibe_quote blocked when not a substring of userMessage');

  // Real quote present → PASS
  const ok = passesHardGate('relationship',
    { current_vibe_quote: '心里暖暖的', current_vibe_label: '温暖' },
    { userMessage: '谢谢你陪我聊，心里暖暖的' });
  assert(ok === true, 'relationship vibe_quote substring → pass');

  // No vibe_quote at all (delta-only) → PASS
  const noVibe = passesHardGate('relationship',
    { intimacy_delta: 0.01 },
    { userMessage: '今天天气不错' });
  assert(noVibe === true, 'relationship without vibe_quote → pass');

  // Quote too short (<2 chars) → BLOCKED
  const tooShort = passesHardGate('relationship',
    { current_vibe_quote: '累' },
    { userMessage: '累' });
  assert(tooShort === false, 'relationship vibe_quote <2 chars blocked');

  const lowEntropy = evaluateHardGate('relationship',
    { current_vibe_quote: '啊啊啊啊', current_vibe_label: '崩溃' },
    { userMessage: '啊啊啊啊' });
  assert(lowEntropy.ok === false, 'relationship low-entropy quote blocked');
  assert(lowEntropy.reason === 'low-entropy', 'relationship low-entropy reason classified');

  const operational = evaluateHardGate('relationship',
    { current_vibe_quote: '只负责防守，不负责进攻', current_vibe_label: '强调纪律性' },
    { userMessage: '今天尾盘持仓风险核查，只负责防守，不负责进攻' });
  assert(operational.ok === false, 'trading operational state blocked from relationship vibe');
  assert(operational.reason === 'operational-state', 'relationship operational-state reason classified');
}

console.log('--- Test 10 [PR2]: active_thread topic_quote + status ---');
{
  const userMsg = '聊聊王阳明';
  assert(passesHardGate('active_threads', { topic_quote: '王阳明', status: 'active' }, { userMessage: userMsg }) === true, 'good thread');
  assert(passesHardGate('active_threads', { topic_quote: 'general', status: 'active' }, { userMessage: userMsg }) === false, 'generic blocked');
  assert(passesHardGate('active_threads', { topic_quote: 'misc', status: 'active' }, { userMessage: userMsg }) === false, 'misc blocked');
  assert(passesHardGate('active_threads', { topic_quote: 'a', status: 'active' }, { userMessage: userMsg }) === false, '<2 chars blocked');
  assert(passesHardGate('active_threads', { topic_quote: '加班', status: 'active' }, { userMessage: '今天一直在加班' }) === true, '2-char chinese topic_quote allowed');
  assert(passesHardGate('active_threads', { topic_quote: '   ', status: 'active' }, { userMessage: userMsg }) === false, 'whitespace topic_quote blocked');
  assert(passesHardGate('active_threads', { topic_quote: '啊啊啊啊', status: 'active' }, { userMessage: '啊啊啊啊' }) === false, 'low-entropy topic_quote blocked');
}

console.log('--- Test 11 [PR2]: active_thread topic_quote must appear in userMessage ---');
{
  const blocked = passesHardGate('active_threads', { topic_quote: '量子力学', status: 'active' }, { userMessage: '今天天气不错' });
  assert(blocked === false, 'topic_quote not in userMessage → blocked');

  // topic_label can be free-form; only topic_quote is gated
  const ok = passesHardGate('active_threads',
    { topic_quote: '王阳明', topic_label: '阳明心学深度探讨', status: 'active' },
    { userMessage: '我在研究王阳明的知行合一' });
  assert(ok === true, 'topic_quote substring + free label → allowed');
}

console.log('--- Test 12 [PR3a]: focus topic_quote must be substring of userMessage ---');
{
  // substring in user → pass
  const ok = passesHardGate('focus',
    { topic_quote: '投稿材料', priority: 9 },
    { userMessage: '这周必须把投稿材料搞完，否则赶不上 ddl' });
  assert(ok === true, 'focus topic_quote substring → pass');

  // not in user → blocked
  const notIn = passesHardGate('focus',
    { topic_quote: '论文投稿', priority: 9 },
    { userMessage: '今天天气不错' });
  assert(notIn === false, 'focus topic_quote not in userMessage → blocked');

  // 1-char quote → blocked by min 2
  const oneChar = evaluateHardGate('focus',
    { topic_quote: '投', priority: 9 },
    { userMessage: '投稿' });
  assert(oneChar.ok === false, '1-char topic_quote blocked');
  assert(oneChar.reason === 'quote-too-short', '1-char quote reason classified');

  // generic English placeholder → blocked
  const genericEn = evaluateHardGate('focus',
    { topic_quote: 'general', priority: 5 },
    { userMessage: 'general topics' });
  assert(genericEn.ok === false, 'generic (english) quote blocked');
  assert(genericEn.reason === 'generic-topic', 'generic-topic reason exposed');

  // [PR3a] Chinese placeholder → blocked (quote)
  const genericZhQuote = evaluateHardGate('focus',
    { topic_quote: '最近', priority: 5 },
    { userMessage: '我最近在忙' });
  assert(genericZhQuote.ok === false, 'Chinese placeholder quote (最近) blocked');
  assert(genericZhQuote.reason === 'generic-topic', '最近 → generic-topic');

  const genericZhQuote2 = evaluateHardGate('focus',
    { topic_quote: '这个', priority: 5 },
    { userMessage: '这个任务' });
  assert(genericZhQuote2.ok === false, 'Chinese placeholder (这个) blocked');

  const genericZhQuote3 = evaluateHardGate('focus',
    { topic_quote: '问题', priority: 5 },
    { userMessage: '问题是什么' });
  assert(genericZhQuote3.ok === false, 'Chinese placeholder (问题) blocked');

  // [PR3a] Generic label (with a real quote) → still blocked (catches paraphrase placeholder)
  const genericLabel = evaluateHardGate('focus',
    { topic_quote: '投稿材料', topic_label: '这个', priority: 5 },
    { userMessage: '投稿材料今天要交' });
  assert(genericLabel.ok === false, 'generic topic_label blocked even with valid quote');
  assert(genericLabel.reason === 'generic-topic', 'generic-topic label reason');

  // [PR3a] Low-entropy quote → blocked
  const lowEntropy = evaluateHardGate('focus',
    { topic_quote: '啊啊啊啊', priority: 5 },
    { userMessage: '啊啊啊啊啊啊啊' });
  assert(lowEntropy.ok === false, 'low-entropy topic_quote blocked');
  assert(lowEntropy.reason === 'low-entropy', 'low-entropy reason classified');

  // [PR3a] Valid quote + valid label → pass
  const withLabel = passesHardGate('focus',
    { topic_quote: '投稿材料', topic_label: '论文投稿准备', priority: 9 },
    { userMessage: '这周必须把投稿材料搞完' });
  assert(withLabel === true, 'valid quote + valid label → pass');
}

console.log('--- Test 12b [PR3a]: active_thread also rejects extended Chinese placeholders ---');
{
  const userMsg = '聊聊王阳明的思想';
  const zh1 = evaluateHardGate('active_threads',
    { topic_quote: '这个', status: 'active' },
    { userMessage: userMsg });
  assert(zh1.ok === false, 'active_thread Chinese placeholder (这个) blocked');
  assert(zh1.reason === 'generic-topic', 'active_thread generic-topic reason');
}

console.log('--- Test 12c: transient body states stay out of relationship/focus/thread ---');
{
  const rel = evaluateHardGate('relationship',
    { current_vibe_quote: '困倦', current_vibe_label: '困倦' },
    { userMessage: '我现在很困倦' });
  assert(rel.ok === false, 'relationship transient body state blocked');
  assert(rel.reason === 'transient-body-state', 'relationship transient reason exposed');

  const focus = evaluateHardGate('focus',
    { topic_quote: '吃饭', priority: 10 },
    { userMessage: '我先去吃饭' });
  assert(focus.ok === false, 'focus transient body action blocked');
  assert(focus.reason === 'transient-body-state', 'focus transient reason exposed');

  const thread = evaluateHardGate('active_threads',
    { topic_quote: '烧水', status: 'active' },
    { userMessage: '我去烧水' });
  assert(thread.ok === false, 'active_thread transient body action blocked');
  assert(thread.reason === 'transient-body-state', 'active_thread transient reason exposed');
}

console.log('--- Test 13: memory_cluster fact must be grounded in user evidence ---');
{
  // fact has no overlap with user evidence -> blocked
  const noOverlap = passesHardGate('memory_clusters',
    { fact: '用户喜欢周杰伦的歌曲', evidence: '今天天气不错', importance_score: 0.5 },
    { userMessage: '今天天气不错', assistantMessage: '是的，很好' });
  assert(noOverlap === false, 'cluster with no evidence overlap -> blocked');

  // fact content is conservatively supported by user evidence
  const withUserOverlap = passesHardGate('memory_clusters',
    { fact: '用户提到今天天气不错', evidence: '今天天气不错', importance_score: 0.5 },
    { userMessage: '今天天气不错', assistantMessage: '是的' });
  assert(withUserOverlap === true, 'cluster with user evidence -> allowed');

  // assistant-only claims are not enough for durable user memory
  const assistantOnly = passesHardGate('memory_clusters',
    { fact: '助手确认了很好', evidence: '今天呢', importance_score: 0.5 },
    { userMessage: '今天呢', assistantMessage: '助手确认很好的结论' });
  assert(assistantOnly === false, 'cluster supported only by assistant text -> blocked');

  // Regression: bot analysis must not be stored as "the user thinks..." when
  // the user's evidence only names the topic.
  const assistantInterpretation = evaluateHardGate('memory_clusters',
    {
      fact: '用户认为线上有一搭没一搭、隔天回消息、发表情包和哈哈哈的聊天模式，比不来电的约会更消耗人，因为它不给明确结论。',
      evidence: '还有一种就是两人在线上聊天，有一搭没一搭的，隔天回个消息，发个表情包，哈哈哈',
      importance_score: 0.7,
    },
    {
      userMessage: '还有一种就是两人在线上聊天，有一搭没一搭的，隔天回个消息，发个表情包，哈哈哈',
      assistantMessage: '这种比今天这种还毒。线上这种有一搭没一搭，会给你还在连接中的幻觉。',
    });
  assert(assistantInterpretation.ok === false, 'assistant interpretation with thin user evidence -> blocked');
  assert(assistantInterpretation.reason === 'fact-not-supported-by-evidence', 'unsupported fact reason classified');

  // fact too short -> blocked
  const tooShort = passesHardGate('memory_clusters',
    { fact: '用户好', evidence: '用户好不好', importance_score: 0.5 },
    { userMessage: '用户好不好', assistantMessage: '' });
  assert(tooShort === false, 'fact below cluster min length -> blocked');
}

console.log('--- Test 14 [PR3b]: sig_memories evidence-only gate (no value_quote required) ---');
{
  // Before PR3b: sig_memories routed through the same gate as basic_info, requiring
  // value_quote. sig_memories has no value_quote → always returned 'quote-too-short'.
  const sigOk = passesHardGate('profile_update',
    { event: '用户在 2024 年拿到 YC 录取', importance: 0.9, date: '2024-04-01', evidence: '我 2024 年拿到 YC 录取' },
    { userMessage: '我 2024 年拿到 YC 录取通知' });
  assert(sigOk === true, 'sig_memory with valid evidence passes evidence-only gate');

  // Evidence not in user → blocked
  const notIn = evaluateHardGate('profile_update',
    { event: 'x', importance: 0.5, date: '2024-01-01', evidence: '完全编造的内容' },
    { userMessage: '我 2024 年拿到 YC 录取' });
  assert(notIn.ok === false, 'sig_memory with fabricated evidence blocked');
  assert(notIn.reason === 'non-substring', 'sig_memory non-substring reason');

  // Short evidence → blocked
  const tooShort = evaluateHardGate('profile_update',
    { event: 'x', importance: 0.5, date: '2024-01-01', evidence: '我 Y' },
    { userMessage: '我 YC' });
  assert(tooShort.ok === false, 'sig_memory short evidence blocked');
  assert(tooShort.reason === 'evidence-too-short', 'evidence-too-short reason');

  // Low-entropy → blocked
  const lowEnt = evaluateHardGate('profile_update',
    { event: 'x', importance: 0.5, date: '2024-01-01', evidence: '啊啊啊啊啊' },
    { userMessage: '啊啊啊啊啊' });
  assert(lowEnt.ok === false, 'sig_memory low-entropy evidence blocked');
  assert(lowEnt.reason === 'low-entropy', 'low-entropy reason for sig_memory');
}

console.log('--- Test 15 [PR3b]: basic_info gate unchanged (value_quote still required) ---');
{
  // Regression guard: shape detection must NOT treat basic_info as sig_memory.
  const userMsg = '我的职业是产品经理';
  const ok = passesHardGate('profile_update',
    { field: 'occupation', value_quote: '产品经理', value_label: '产品经理', evidence: '我的职业是产品经理' },
    { userMessage: userMsg });
  assert(ok === true, 'basic_info with value_quote passes');

  // basic_info missing value_quote → still blocked by value-required gate
  const missingQuote = evaluateHardGate('profile_update',
    { field: 'occupation', evidence: '我的职业是产品经理' },
    { userMessage: userMsg });
  assert(missingQuote.ok === false, 'basic_info without value_quote blocked');
}

console.log('--- Test 15b [P2-001]: past-tense occupation is blocked from current profile ---');
{
  const past = evaluateHardGate('profile_update',
    { field: 'occupation', value_quote: '工程师', value_label: '工程师', evidence: '我以前是工程师' },
    { userMessage: '我以前是工程师' });
  assert(past.ok === false, 'past-tense occupation blocked');
  assert(past.reason === 'profile-past-occupation', 'past-tense reason exposed');

  const mixed = evaluateHardGate('profile_update',
    { field: 'occupation', value_quote: '产品经理', value_label: '产品经理', evidence: '我现在是产品经理' },
    { userMessage: '我现在是产品经理，以前是工程师' });
  assert(mixed.ok === true, 'current occupation still passes when past role is also mentioned later');

  const englishPast = evaluateHardGate('profile_update',
    { field: 'occupation', value_quote: 'engineer', value_label: 'engineer', evidence: 'I used to be an engineer' },
    { userMessage: 'I used to be an engineer' });
  assert(englishPast.ok === false, 'english past-tense occupation blocked');

  const englishMixed = evaluateHardGate('profile_update',
    { field: 'occupation', value_quote: 'product manager', value_label: 'product manager', evidence: 'I am a product manager now' },
    { userMessage: 'I am a product manager now, but I used to be an engineer' });
  assert(englishMixed.ok === true, 'english current occupation still passes when old role is mentioned later');
}

console.log('--- Test 15c [P2-002]: temporary profile fields are blocked ---');
{
  const locationContext = evaluateHardGate('profile_update',
    { field: 'location_context', value_quote: '在公司', evidence: '现在在公司' },
    { userMessage: '现在在公司' });
  assert(locationContext.ok === false, 'location_context blocked from durable profile');
  assert(locationContext.reason === 'profile-temporary-state', 'temporary profile reason exposed');

  const investmentActivity = evaluateHardGate('profile_update',
    { field: 'investment_activity', value_quote: '减仓', evidence: '我尾盘减仓了' },
    { userMessage: '我尾盘减仓了' });
  assert(investmentActivity.ok === false, 'investment_activity blocked from durable profile');

  const occupationPlace = evaluateHardGate('profile_update',
    { field: 'occupation', value_quote: '公司', evidence: '我现在在公司' },
    { userMessage: '我现在在公司' });
  assert(occupationPlace.ok === false, 'being at company blocked as occupation');
  assert(occupationPlace.reason === 'profile-temporary-state', 'occupation temporary reason exposed');
}

console.log('--- Test 16 [PR4]: profile filters reject harmful business/org/meta evidence ---');
{
  // [PR4] Business predicate: 咱们团队在提供 ... → service-org fact, not user.
  // `咱们` + within 6 chars + `团队/提供/方案` → BUSINESS_PREDICATE matches.
  const biz = evaluateHardGate('profile_update',
    { field: 'occupation', value_quote: 'AI 教育', value_label: 'AI 教育',
      evidence: '咱们团队在提供 AI 教育产品' },
    { userMessage: '咱们团队在提供 AI 教育产品' });
  assert(biz.ok === false, '咱们团队在提供 blocked (business predicate)');
  assert(biz.reason === 'profile-business-predicate', 'business-predicate reason exposed');

  // [PR4] ORG_NOUN is narrower than the prev `我们` rule — explicit org nouns.
  // 我司 does NOT match BUSINESS (no 我们/咱们 prefix), so this cleanly tests ORG branch.
  const org = evaluateHardGate('profile_update',
    { field: 'occupation', value_quote: '金融客户', value_label: '金融客户',
      evidence: '我司主要服务金融客户' },
    { userMessage: '我司主要服务金融客户' });
  assert(org.ok === false, '我司 blocked (org noun)');
  assert(org.reason === 'profile-org-noun', 'org-noun reason exposed');

  const org2 = evaluateHardGate('profile_update',
    { field: 'city', value_quote: '上海', value_label: '上海',
      evidence: '本公司在上海' },
    { userMessage: '本公司在上海' });
  assert(org2.ok === false, '本公司 blocked');
  assert(org2.reason === 'profile-org-noun', '本公司 → org-noun reason');

  // [PR4] Meta prefix: 文档标题：X  — raw evidence keeps colon, META_PREFIX matches.
  // Regression guard: normalize() would strip `：`, so the filter MUST run on raw.
  const meta = evaluateHardGate('profile_update',
    { field: 'fitness_goal', value_quote: '减肥计划', value_label: '减肥计划',
      evidence: '文档标题：减肥计划' },
    { userMessage: '文档标题：减肥计划' });
  assert(meta.ok === false, '文档标题：前缀 blocked');
  assert(meta.reason === 'profile-meta-prefix', 'meta-prefix reason exposed');

  // ASCII-colon + English label variant — same filter, different character.
  const metaAscii = evaluateHardGate('profile_update',
    { field: 'name', value_quote: '产品文档', value_label: '产品文档',
      evidence: 'schema: 产品文档' },
    { userMessage: 'schema: 产品文档' });
  assert(metaAscii.ok === false, 'schema: 前缀 blocked (ASCII colon)');
  assert(metaAscii.reason === 'profile-meta-prefix', 'ASCII meta-prefix reason exposed');
}

console.log('--- Test 17 [PR4]: profile filters keep legitimate family/personal facts ---');
{
  // False-positive guard — `我们家` / `咱们老家` are family usage, not business.
  // These must still pass, otherwise PR4 over-rejects and regresses normal profile.
  const family = passesHardGate('profile_update',
    { field: 'city', value_quote: '北京', value_label: '北京',
      evidence: '我们家住北京朝阳' },
    { userMessage: '我们家住北京朝阳' });
  assert(family === true, '我们家住北京朝阳 → pass (family usage, no business verb)');

  const hometown = passesHardGate('profile_update',
    { field: 'hometown', value_quote: '东北', value_label: '东北',
      evidence: '咱们老家东北的冬天很冷' },
    { userMessage: '咱们老家东北的冬天很冷' });
  assert(hometown === true, '咱们老家东北 → pass (family origin, no business verb)');

  // Plain `我` subject — baseline regression: PR4 must not leak into normal cases.
  const plain = passesHardGate('profile_update',
    { field: 'occupation', value_quote: '产品经理', value_label: '产品经理',
      evidence: '我的职业是产品经理' },
    { userMessage: '我的职业是产品经理' });
  assert(plain === true, '我的职业是产品经理 → pass (plain user fact)');
}

console.log('--- Test 18 [PR4]: sig_memories path untouched by profile filters ---');
{
  // Shape detect on `event` routes to checkEvidenceOnly, which does not call
  // the PR4 filters. An evidence string containing 我们公司 must still pass
  // sig_memory's evidence-only gate — business is a legitimate sig_memory.
  const sigBiz = passesHardGate('profile_update',
    { event: '公司 2024 融资完成', importance: 0.8, date: '2024-06-01',
      evidence: '我们公司 2024 融资' },
    { userMessage: '我们公司 2024 融资的消息' });
  assert(sigBiz === true, 'sig_memory with 我们公司 evidence → pass (PR4 filters skip sig path)');
}

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
if (failed > 0) process.exit(1);
