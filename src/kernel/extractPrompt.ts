/**
 * memware kernel — extraction prompt (contract-shaped output).
 *
 * The local product extracts memware's own rich document model; the kernel
 * instead asks the model for exactly the contract shape the backend stores
 * (handoff §5.1 / §8). Two rules are prompt-level and must stay verbatim:
 *   1. only facts whose subject is the user themselves;
 *   2. other people are entity candidates, never fact subjects.
 *
 * Any wording change here changes extraction behaviour → bump `extractorVersion`.
 */

import type { ExtractRequest, KnownEntity } from "./extractSchema";
import { FactCategories } from "./extractSchema";

export const kernelExtractSystemPrompt = [
  "你是记忆提炼引擎。你的唯一任务是从对话中提炼关于「用户本人」的长期记忆，并输出严格 JSON。",
  "",
  "硬性规则：",
  "1. 只提炼以用户本人为主语的偏好、事实、结论。用户说的话优先，助手的话只能用于补全语境。",
  "2. 他人（同事、客户、家人、公众人物等）不得成为事实的主语；关于他们的信息只能作为实体候选出现在 entities 中。",
  "   例：「我和张三一起负责供应商评审」→ 事实主语是用户，张三写入 entities；「张三是产品经理」→ 不产生事实。",
  "3. 只提炼跨会话仍然成立的长期信息。一次性的操作请求、临时状态、寒暄、待办的执行细节都不要提炼。",
  "4. 不要推测、不要合并多条信息、不要改写成你自己的判断。一条事实一句话。",
  "5. 每条事实必须给出 messageIds：它们只能取自输入里出现过的消息编号，不得虚构。",
  "6. category 取值只能是：" + FactCategories.join(" / ") + "。",
  "   preference = 用户的偏好或习惯；fact = 用户的客观情况；conclusion = 从对话中得出的关于用户的结论。",
  "7. confidence 为 0 到 1 的小数，表示该事实成立的把握。",
  "8. entities 给出对话中出现的实体候选：name 用规范名称，type 取 person / project / topic / tool / place 等，aliases 给出对话中出现的其他叫法。",
  "9. 若提供了已知实体，指代同一对象时必须使用其 canonicalName，不要新造名称。",
  "10. 没有可提炼内容时返回空数组，不要编造。",
  "",
  "输出格式（严格 JSON，不要 markdown 代码块、不要解释文字）：",
  '{"facts":[{"content":"...","category":"preference","confidence":0.9,"messageIds":["..."],"entities":["..."]}],',
  '"entities":[{"name":"...","type":"person","aliases":["..."]}]}',
].join("\n");

function formatKnownEntity(entity: KnownEntity): string {
  const aliases = entity.aliases?.filter((a) => a.trim().length > 0) ?? [];
  const aliasPart = aliases.length > 0 ? `｜别名：${aliases.join("、")}` : "";
  return `- ${entity.canonicalName}（${entity.entityType}）${aliasPart}`;
}

/** Collapse whitespace so one message stays on one numbered line. */
function flatten(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Render the request as a numbered transcript.
 *
 * Message lines are `[conversationId/messageId] role: text`, which is how the
 * model is told to reference sources. The request's `userId` is deliberately
 * NOT included — tenant identity must never reach a third-party model
 * (handoff §5.4.3).
 */
export function buildKernelExtractUserMessage(request: ExtractRequest): string {
  const parts: string[] = [];

  const known = request.knownEntities ?? [];
  parts.push("已知实体（指代同一对象时必须使用 canonicalName）：");
  parts.push(known.length > 0 ? known.map(formatKnownEntity).join("\n") : "（无）");
  parts.push("");
  parts.push("对话（每行格式：[会话/消息编号] 角色: 正文）：");

  for (const conversation of request.conversations) {
    for (const message of conversation.messages) {
      parts.push(
        `[${conversation.conversationId}/${message.messageId}] ${message.role}: ${flatten(message.text)}`,
      );
    }
  }

  parts.push("");
  parts.push("请按系统提示的 JSON 格式输出。");
  return parts.join("\n");
}
