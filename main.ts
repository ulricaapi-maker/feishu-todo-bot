type TodoNote = {
  text: string;
  createdAt: string;
};

type Todo = {
  text: string;
  done: boolean;
  createdAt: string;
  doneAt?: string;
  notes?: TodoNote[];
};

type PendingNote = {
  numbers: number[];
  createdAt: string;
};

const FORWARD_MESSAGE_TYPES = ["merge_forward", "forward", "chat_history"];

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch (_error) {
    return value;
  }
}

function parseTodoNumbers(value: string): number[] {
  return value
    .split(/[，,、\s]+/)
    .map((item) => parseChineseNumber(item.trim()) || Number(item.trim()))
    .filter((item) => Number.isInteger(item) && item > 0);
}

function truncate(value: string, maxLength = 800): string {
  if (value.length <= maxLength) {
    return value;
  }

  return value.slice(0, maxLength) + "...";
}

function cleanSummaryText(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .replace(/\{.*?\}/g, "")
    .trim();
}

function collectReadableText(value: unknown, depth = 0): string[] {
  if (!value || depth > 8) {
    return [];
  }

  if (typeof value === "string") {
    const text = cleanSummaryText(value);
    return text ? [text] : [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => collectReadableText(item, depth + 1));
  }

  if (typeof value === "object") {
    const item = value as Record<string, unknown>;
    const texts: string[] = [];
    const usefulKeys = [
      "title",
      "text",
      "name",
      "summary",
      "description",
      "content",
      "body",
      "elements",
      "items",
      "messages",
      "message",
      "sender",
      "user_name",
      "href",
      "url",
    ];

    usefulKeys.forEach((key) => {
      if (key in item) {
        texts.push(...collectReadableText(item[key], depth + 1));
      }
    });

    return texts;
  }

  return [];
}

function uniqueLines(lines: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  lines.forEach((line) => {
    const text = cleanSummaryText(line);

    if (!text || seen.has(text)) {
      return;
    }

    seen.add(text);
    result.push(text);
  });

  return result;
}

function messageItemToReadableLines(item: any): string[] {
  const messageType = item?.msg_type || item?.message_type || item?.body?.msg_type || "unknown";
  const sender =
    item?.sender?.sender_id?.user_id ||
    item?.sender?.sender_id?.open_id ||
    item?.sender?.id ||
    item?.sender?.name ||
    "";
  const rawContent = item?.body?.content || item?.content || item?.message?.content;
  const content = parseMaybeJson(rawContent);
  const lines = uniqueLines(collectReadableText(content));

  if (lines.length === 0) {
    return [];
  }

  const prefix = sender ? sender + "：" : "";

  if (messageType === "image") {
    return [prefix + "[图片]"];
  }

  return lines.map((line) => prefix + line);
}

function extractForwardMessageLines(fullMessage: any): string[] {
  const items = Array.isArray(fullMessage?.items)
    ? fullMessage.items
    : Array.isArray(fullMessage?.data?.items)
      ? fullMessage.data.items
      : Array.isArray(fullMessage)
        ? fullMessage
        : [];

  const lines = items.flatMap((item: any) => messageItemToReadableLines(item));

  if (lines.length > 0) {
    return uniqueLines(lines);
  }

  return uniqueLines(collectReadableText(fullMessage));
}

function formatReadableSummary(title: string, lines: string[], fallback: string): string {
  const cleanLines = uniqueLines(lines)
    .filter((line) => line.length > 1)
    .slice(0, 8);

  if (cleanLines.length === 0) {
    return fallback;
  }

  const output = [title + "："];
  cleanLines.forEach((line, index) => {
    output.push(index + 1 + ". " + truncate(line, 160));
  });

  return output.join("\n");
}

async function callAI(systemPrompt: string, userPrompt: string): Promise<string | null> {
  const deepseekKey = Deno.env.get("DEEPSEEK_API_KEY");
  const openaiKey = Deno.env.get("OPENAI_API_KEY");

  if (deepseekKey) {
    const response = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + deepseekKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        temperature: 0.2,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
    });

    const data = await response.json();

    if (!response.ok || data.error) {
      console.log("DeepSeek 调用失败：", data.error || data);
      return null;
    }

    return data.choices?.[0]?.message?.content?.trim() || null;
  }

  if (!openaiKey) {
    console.log("AI 未启用：缺少 DEEPSEEK_API_KEY 或 OPENAI_API_KEY");
    return null;
  }

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + openaiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-5.4-mini",
      instructions: systemPrompt,
      input: userPrompt,
    }),
  });

  const data = await response.json();

  if (!response.ok || data.error) {
    console.log("AI 摘要失败：", data.error || data);
    return null;
  }

  return data.output_text || data.output?.flatMap((item: any) => item.content || [])
    ?.map((content: any) => content.text || "")
    ?.join("\n")
    ?.trim() || null;
}

async function summarizeWithAI(title: string, rawText: string): Promise<string | null> {
  if (!rawText.trim()) {
    return null;
  }

  const text = await callAI(
    [
      "你是一个飞书待办上下文整理助手。",
      "请把用户转发的聊天记录、富文本、文件说明或普通文字整理成简短中文摘要。",
      "输出要适合作为待办事项的上下文，不要寒暄，不要编造。",
      "如果能看出行动项、负责人、截止时间、字段名、争议点，请优先提取。",
      "最多 5 条，每条不超过 40 个中文字符。",
    ].join("\n"),
    "标题：" + title + "\n\n原始内容：\n" + truncate(rawText, 6000),
  );

  return text ? "AI 摘要：\n" + text : null;
}

function flattenPostContent(value: unknown): string[] {
  return collectReadableText(value);
}

async function getKv(): Promise<Deno.Kv> {
  return Deno.openKv();
}

async function readTodos(): Promise<Todo[]> {
  const kv = await getKv();
  const result = await kv.get<Todo[]>(["todos"]);
  return result.value || [];
}

async function writeTodos(todos: Todo[]): Promise<void> {
  const kv = await getKv();
  await kv.set(["todos"], todos);
}

async function addTodo(text: string): Promise<string> {
  const todos = await readTodos();

  todos.push({
    text,
    done: false,
    createdAt: new Date().toISOString(),
  });

  await writeTodos(todos);
  return "已添加待办：" + text;
}

async function formatTodoList(): Promise<string> {
  const todos = await readTodos();
  const openTodos = todos.filter((todo) => !todo.done);

  if (openTodos.length === 0) {
    return "目前没有待办";
  }

  const lines = ["待办清单："];

  openTodos.forEach((todo, index) => {
    lines.push(index + 1 + ". " + todo.text);
  });

  return lines.join("\n");
}

async function doneTodo(number: number): Promise<string> {
  const todos = await readTodos();
  const openTodos = todos.filter((todo) => !todo.done);
  const todo = openTodos[number - 1];

  if (!todo) {
    return "没有找到这个编号的待办";
  }

  todo.done = true;
  todo.doneAt = new Date().toISOString();

  await writeTodos(todos);
  return "已完成：" + todo.text;
}

async function deleteTodo(number: number): Promise<string> {
  const todos = await readTodos();
  const openTodos = todos.filter((todo) => !todo.done);
  const todo = openTodos[number - 1];

  if (!todo) {
    return "没有找到这个编号的待办";
  }

  const nextTodos = todos.filter((item) => item !== todo);
  await writeTodos(nextTodos);

  return "已删除：" + todo.text;
}

async function addNotes(numbers: number[], text: string): Promise<string> {
  const cleanText = text.trim();

  if (numbers.length === 0) {
    return "请告诉我要补充到哪条待办，比如：补充 1 上下文";
  }

  if (!cleanText) {
    return "请写要补充的内容，比如：补充 1 这里是上下文";
  }

  const todos = await readTodos();
  const openTodos = todos.filter((todo) => !todo.done);
  const changed: string[] = [];
  const missing: number[] = [];

  numbers.forEach((number) => {
    const todo = openTodos[number - 1];

    if (!todo) {
      missing.push(number);
      return;
    }

    todo.notes ||= [];
    todo.notes.push({
      text: cleanText,
      createdAt: new Date().toISOString(),
    });

    changed.push(number + ". " + todo.text);
  });

  if (changed.length === 0) {
    return "没有找到这些编号的待办：" + missing.join("、");
  }

  await writeTodos(todos);

  const lines = ["已补充到：", ...changed];

  if (missing.length > 0) {
    lines.push("未找到：" + missing.join("、"));
  }

  return lines.join("\n");
}

async function formatTodoDetail(number: number): Promise<string> {
  const todos = await readTodos();
  const openTodos = todos.filter((todo) => !todo.done);
  const todo = openTodos[number - 1];

  if (!todo) {
    return "没有找到这个编号的待办";
  }

  const lines = [
    "待办详情：",
    number + ". " + todo.text,
  ];

  if (!todo.notes || todo.notes.length === 0) {
    lines.push("暂无补充上下文");
    return lines.join("\n");
  }

  lines.push("上下文：");
  todo.notes.forEach((note, index) => {
    lines.push(index + 1 + ". " + note.text);
  });

  return lines.join("\n");
}

async function summarizeTodo(number: number): Promise<string> {
  const todos = await readTodos();
  const openTodos = todos.filter((todo) => !todo.done);
  const todo = openTodos[number - 1];

  if (!todo) {
    return "没有找到这个编号的待办";
  }

  const noteText = todo.notes?.map((note, index) => index + 1 + ". " + note.text).join("\n") || "";

  if (!noteText.trim()) {
    return "这个待办还没有补充上下文，我只能看到标题：" + todo.text;
  }

  const summary = await summarizeWithAI(
    "待办：" + todo.text,
    [
      "待办标题：" + todo.text,
      "",
      "上下文：",
      noteText,
    ].join("\n"),
  );

  return summary || formatTodoDetail(number);
}

async function clearTodos(): Promise<string> {
  const todos = await readTodos();

  todos.forEach((todo) => {
    if (!todo.done) {
      todo.done = true;
      todo.doneAt = new Date().toISOString();
    }
  });

  await writeTodos(todos);
  return "已清空所有未完成待办";
}

async function savePendingNote(chatId: string, numbers: number[]): Promise<void> {
  const kv = await getKv();
  await kv.set(["pending_note", chatId], {
    numbers,
    createdAt: new Date().toISOString(),
  } satisfies PendingNote, { expireIn: 1000 * 60 * 15 });
}

async function getPendingNote(chatId: string): Promise<PendingNote | null> {
  const kv = await getKv();
  const result = await kv.get<PendingNote>(["pending_note", chatId]);
  return result.value || null;
}

async function clearPendingNote(chatId: string): Promise<void> {
  const kv = await getKv();
  await kv.delete(["pending_note", chatId]);
}

type NaturalIntent = {
  action: "add" | "list" | "done" | "delete" | "detail" | "summarize" | "clear" | "start_note" | "cancel_note" | "unknown";
  text?: string;
  numbers?: number[];
};

function extractJsonObject(value: string): NaturalIntent | null {
  const match = value.match(/\{[\s\S]*\}/);

  if (!match) {
    return null;
  }

  try {
    return JSON.parse(match[0]);
  } catch (_error) {
    return null;
  }
}

async function interpretNaturalText(text: string): Promise<NaturalIntent | null> {
  if (!text.trim()) {
    return null;
  }

  const currentTodos = await readTodos();
  const openTodos = currentTodos
    .filter((todo) => !todo.done)
    .map((todo, index) => index + 1 + ". " + todo.text)
    .join("\n") || "目前没有待办";

  const outputText = await callAI(
    [
      "你是飞书待办机器人的意图解析器，只输出 JSON，不要输出解释。",
      "把用户中文口语转换为一个动作。",
      "可选 action: add, list, done, delete, detail, summarize, clear, start_note, cancel_note, unknown。",
      "add 需要 text。",
      "done/delete/detail/summarize/start_note 需要 numbers 数组。",
      "如果用户说总结、整理、分析某个已有待办，用 summarize，并填 numbers。",
      "如果用户说补充上下文、接下来发聊天记录、把后面的内容补到某几条，用 start_note。",
      "如果用户只是闲聊或不确定，用 unknown。",
    ].join("\n"),
    [
      "当前未完成待办：",
      openTodos,
      "",
      "用户消息：" + text,
      "",
      "请输出 JSON，例如：{\"action\":\"detail\",\"numbers\":[1]}",
    ].join("\n"),
  );

  const intent = outputText ? extractJsonObject(outputText) : null;

  if (!intent) {
    console.log("AI 意图解析没有返回可用 JSON：", outputText || "空响应");
  }

  return intent;
}

async function runNaturalIntent(intent: NaturalIntent, chatId?: string): Promise<string | null> {
  if (intent.action === "add" && intent.text) {
    return addTodo(intent.text);
  }

  if (intent.action === "list") {
    return formatTodoList();
  }

  if (intent.action === "clear") {
    return clearTodos();
  }

  if (intent.action === "cancel_note") {
    if (chatId) {
      await clearPendingNote(chatId);
    }
    return "已取消补充";
  }

  const firstNumber = intent.numbers?.[0];

  if (intent.action === "done" && firstNumber) {
    return doneTodo(firstNumber);
  }

  if (intent.action === "delete" && firstNumber) {
    return deleteTodo(firstNumber);
  }

  if (intent.action === "detail" && firstNumber) {
    return formatTodoDetail(firstNumber);
  }

  if (intent.action === "summarize" && firstNumber) {
    return summarizeTodo(firstNumber);
  }

  if (intent.action === "start_note" && intent.numbers?.length && chatId) {
    await savePendingNote(chatId, intent.numbers);
    return "好的，请把要补充的文字或聊天记录发给我。15 分钟内有效；如需取消，发送：取消补充";
  }

  return null;
}

function parseChineseNumber(value: string): number | null {
  const normalized = value.trim().replace(/^第/, "").replace(/[个条项号]$/, "");
  const digit = normalized.match(/\d+/);

  if (digit) {
    return Number(digit[0]);
  }

  const map: Record<string, number> = {
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
    十: 10,
  };

  return map[normalized] || null;
}

function findTodoNumbersInText(text: string): number[] {
  const matches = text.match(/第?\s*[\d一二两三四五六七八九十]+\s*(?:个|条|项|号)?/g) || [];
  return matches
    .map((item) => parseChineseNumber(item))
    .filter((item): item is number => Boolean(item));
}

function normalizeForMatch(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

async function findTodoNumberByText(text: string): Promise<number | null> {
  const todos = await readTodos();
  const openTodos = todos.filter((todo) => !todo.done);
  const normalizedText = normalizeForMatch(text);

  let bestNumber: number | null = null;
  let bestScore = 0;

  openTodos.forEach((todo, index) => {
    const normalizedTodo = normalizeForMatch(todo.text);

    if (!normalizedTodo) {
      return;
    }

    let score = 0;

    if (normalizedText.includes(normalizedTodo)) {
      score += normalizedTodo.length + 10;
    }

    normalizedTodo.match(/[\p{L}\p{N}]{2,}/gu)?.forEach((part) => {
      if (normalizedText.includes(part)) {
        score += part.length;
      }
    });

    if (score > bestScore) {
      bestScore = score;
      bestNumber = index + 1;
    }
  });

  return bestScore >= 2 ? bestNumber : null;
}

async function parseNaturalFallback(text: string): Promise<NaturalIntent | null> {
  const trimmed = text.trim();
  const numbers = findTodoNumbersInText(trimmed);
  const matchedNumber = numbers[0] || await findTodoNumberByText(trimmed);

  if (
    /^(看一下|看下)?(待办)?(列表|清单)$/.test(trimmed) ||
    /(还有|剩下).*(哪些|什么|啥).*待办/.test(trimmed) ||
    /(待办|任务).*(有哪些|是什么|给我看看)/.test(trimmed)
  ) {
    return { action: "list" };
  }

  if (/^(取消补充|不补充了|算了)$/.test(trimmed)) {
    return { action: "cancel_note" };
  }

  if (/(总结|整理|分析|复盘|归纳|智能总结)/.test(trimmed) && matchedNumber) {
    return { action: "summarize", numbers: [matchedNumber] };
  }

  if (/(补充|上下文|聊天记录|对话|下一条|后面|转发)/.test(trimmed) && matchedNumber) {
    return { action: "start_note", numbers: [matchedNumber] };
  }

  if (/(完成|做完|搞定|处理完|办完|结束|关掉)/.test(trimmed) && matchedNumber) {
    return { action: "done", numbers: [matchedNumber] };
  }

  if (/(删掉|删除|去掉|移除|不要了)/.test(trimmed) && matchedNumber) {
    return { action: "delete", numbers: [matchedNumber] };
  }

  if (/(详情|看看|看下|看一下|具体|上下文|这个任务|这个待办)/.test(trimmed) && matchedNumber) {
    return { action: "detail", numbers: [matchedNumber] };
  }

  const addMatch = trimmed.match(/^(?:帮我|麻烦)?(?:记一下|记录一下|加一下|加一个待办|添加待办|新增待办|待办|提醒我|要处理|需要跟进|帮我跟进)\s*[：:]?\s*(.+)$/);
  if (addMatch?.[1]?.trim()) {
    return { action: "add", text: addMatch[1].trim() };
  }

  if (
    trimmed.length >= 4 &&
    trimmed.length <= 80 &&
    !/[?？]/.test(trimmed) &&
    /(确认|跟进|处理|检查|看看|对齐|整理|回复|补充|评审|核对)/.test(trimmed)
  ) {
    return { action: "add", text: trimmed };
  }

  return null;
}

async function handleText(text: string, chatId?: string): Promise<string> {
  const trimmed = text.trim();

  if (trimmed === "列表") {
    return formatTodoList();
  }

  if (trimmed === "清空") {
    return clearTodos();
  }

  if (trimmed === "取消补充") {
    if (chatId) {
      await clearPendingNote(chatId);
    }

    return "已取消补充";
  }

  if (trimmed.startsWith("完成 ")) {
    const number = Number(trimmed.replace("完成 ", ""));
    return doneTodo(number);
  }

  if (trimmed.startsWith("删除 ")) {
    const number = Number(trimmed.replace("删除 ", ""));
    return deleteTodo(number);
  }

  if (trimmed.startsWith("详情 ")) {
    const number = Number(trimmed.replace("详情 ", ""));
    return formatTodoDetail(number);
  }

  if (trimmed.startsWith("补充 ")) {
    const match = trimmed.match(/^补充\s+([\d，,、\s]+)(?:\s+([\s\S]+))?$/);

    if (!match) {
      return "格式不对，请这样发：补充 1 上下文，或补充 1,2";
    }

    const numbers = parseTodoNumbers(match[1]);
    const note = match[2] || "";

    if (note.trim()) {
      return addNotes(numbers, note);
    }

    if (!chatId) {
      return "请写要补充的内容，比如：补充 1 这里是上下文";
    }

    await savePendingNote(chatId, numbers);
    return "好的，请把要补充的文字或聊天记录发给我。15 分钟内有效；如需取消，发送：取消补充";
  }

  if (trimmed.startsWith("添加 ")) {
    const todoText = trimmed.replace("添加 ", "");
    return addTodo(todoText);
  }

  const fallbackIntent = await parseNaturalFallback(trimmed);

  if (fallbackIntent) {
    const fallbackReply = await runNaturalIntent(fallbackIntent, chatId);

    if (fallbackReply) {
      return fallbackReply;
    }
  }

  const naturalIntent = await interpretNaturalText(trimmed);

  if (naturalIntent) {
    const naturalReply = await runNaturalIntent(naturalIntent, chatId);

    if (naturalReply) {
      return naturalReply;
    }
  }

  return [
    "我现在支持这些命令：",
    "添加 待办内容",
    "列表",
    "完成 1",
    "删除 1",
    "补充 1 上下文",
    "补充 1,2",
    "详情 1",
    "取消补充",
    "清空",
  ].join("\n");
}

function getTextFromFeishuMessage(message: any): string {
  if (!message || message.message_type !== "text") {
    return "";
  }

  try {
    const content = JSON.parse(message.content || "{}");
    return content.text || "";
  } catch (_error) {
    return "";
  }
}

async function summarizeFeishuMessage(message: any): Promise<string> {
  const messageId = message?.message_id || "未知 message_id";
  const messageType = message?.message_type || "unknown";

  try {
    let content = parseMaybeJson(message?.content || "{}");
    let fullMessage: any | null = null;

    if (FORWARD_MESSAGE_TYPES.includes(messageType)) {
      fullMessage = await getFeishuMessageContent(messageId);

      if (fullMessage?.body?.content) {
        content = parseMaybeJson(fullMessage.body.content);
      }
    }

    if (messageType === "text") {
      const text = typeof content === "object" && content && "text" in content
        ? String((content as Record<string, unknown>).text || "")
        : "";
      const aiSummary = await summarizeWithAI("普通文字", text);
      return aiSummary || text;
    }

    if (messageType === "post") {
      const postContent = typeof content === "object" && content ? content as Record<string, unknown> : {};
      const title = postContent.title ? "富文本 - " + String(postContent.title) : "富文本";
      const lines = collectReadableText(postContent.content);
      const rawText = lines.join("\n");
      const aiSummary = await summarizeWithAI(title, rawText);
      return aiSummary || formatReadableSummary("富文本摘要", lines, "收到一条富文本消息");
    }

    if (FORWARD_MESSAGE_TYPES.includes(messageType)) {
      let lines = collectReadableText(content);

      if (fullMessage) {
        lines = [
          ...lines,
          ...extractForwardMessageLines(fullMessage),
        ];
      }

      const rawText = uniqueLines(lines).join("\n");
      const aiSummary = await summarizeWithAI("转发聊天记录", rawText || JSON.stringify(content || {}));

      if (!rawText.trim()) {
        console.log("转发消息没有解析到正文：", {
          messageId,
          messageType,
          content,
          fullMessageKeys: fullMessage ? Object.keys(fullMessage) : [],
        });
      }

      return aiSummary || formatReadableSummary(
        "转发聊天记录摘要",
        lines,
        [
          "收到一条转发聊天记录，但飞书这次没有把正文开放给机器人。",
          "message_id: " + messageId,
          "可以改用：复制聊天文字后发送，或把单条消息逐条转发给我。",
        ].join("\n"),
      );
    }

    if (messageType === "image") {
      return "图片上下文：收到一张图片。\nmessage_id: " + messageId;
    }

    if (messageType === "file") {
      const fileContent = typeof content === "object" && content ? content as Record<string, unknown> : {};
      const name = fileContent.file_name || fileContent.name || "未命名文件";
      const aiSummary = await summarizeWithAI("文件", JSON.stringify(content));
      return aiSummary || "文件上下文：" + name + "。\nmessage_id: " + messageId;
    }

    if (messageType === "audio") {
      return "语音上下文：收到一条语音消息。\nmessage_id: " + messageId;
    }

    const lines = collectReadableText(content);
    const rawText = lines.join("\n") || JSON.stringify(content);
    const aiSummary = await summarizeWithAI("消息类型：" + messageType, rawText);
    return aiSummary || formatReadableSummary(
      "消息摘要（" + messageType + "）",
      lines,
      "收到一条「" + messageType + "」消息。\nmessage_id: " + messageId,
    );
  } catch (_error) {
    return "收到一条「" + messageType + "」消息。\nmessage_id: " + messageId;
  }
}

async function markMessageProcessed(messageId: string): Promise<boolean> {
  const kv = await getKv();
  const key = ["processed_message", messageId];
  const existed = await kv.get<boolean>(key);

  if (existed.value) {
    return false;
  }

  await kv.set(key, true, { expireIn: 1000 * 60 * 60 * 24 });
  return true;
}

async function getTenantAccessToken(): Promise<string | null> {
  const response = await fetch(
    "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        app_id: Deno.env.get("FEISHU_APP_ID"),
        app_secret: Deno.env.get("FEISHU_APP_SECRET"),
      }),
    },
  );

  const data = await response.json();

  if (data.code !== 0) {
    console.log("获取飞书访问令牌失败：", data);
    return null;
  }

  return data.tenant_access_token;
}

async function getFeishuMessageContent(messageId: string): Promise<any | null> {
  const token = await getTenantAccessToken();

  if (!token) {
    return null;
  }

  const response = await fetch(
    "https://open.feishu.cn/open-apis/im/v1/messages/" + messageId,
    {
      method: "GET",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json; charset=utf-8",
      },
    },
  );

  const data = await response.json();

  if (data.code !== 0) {
    console.log("获取飞书消息内容失败：", data);
    return null;
  }

  return data.data || null;
}

async function sendFeishuMessage(chatId: string, text: string): Promise<void> {
  const token = await getTenantAccessToken();

  if (!token) {
    return;
  }

  const response = await fetch(
    "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id",
    {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        receive_id: chatId,
        msg_type: "text",
        content: JSON.stringify({ text }),
      }),
    },
  );

  const data = await response.json();

  if (data.code !== 0) {
    console.log("发送飞书消息失败：", data);
  }
}

async function saveChatId(chatId: string): Promise<void> {
  const kv = await getKv();
  await kv.set(["settings", "chatId"], chatId);
}

async function getSavedChatId(): Promise<string | null> {
  const kv = await getKv();
  const result = await kv.get<string>(["settings", "chatId"]);
  return result.value || null;
}

async function sendReminder(): Promise<void> {
  const chatId = await getSavedChatId();

  if (!chatId) {
    console.log("还没有保存 chat_id，先在飞书里给机器人发一条消息");
    return;
  }

  const list = await formatTodoList();

  if (list === "目前没有待办") {
    return;
  }

  await sendFeishuMessage(chatId, "待办提醒：\n" + list);
}

Deno.cron("morning-todo-reminder", "0 2 * * *", sendReminder);
Deno.cron("evening-todo-reminder", "30 9 * * *", sendReminder);

async function processFeishuMessage(body: any): Promise<void> {
  const message = body.event && body.event.message;
  const chatId = message && message.chat_id;
  const messageId = message && message.message_id;

  if (!chatId || !messageId) {
    return;
  }

  const shouldProcess = await markMessageProcessed(messageId);

  if (!shouldProcess) {
    return;
  }

  await saveChatId(chatId);

  const text = getTextFromFeishuMessage(message);
  const pending = await getPendingNote(chatId);

  if (text.trim() === "取消补充") {
    const reply = await handleText(text, chatId);
    await sendFeishuMessage(chatId, reply);
    return;
  }

  if (pending) {
    const note = await summarizeFeishuMessage(message);
    const reply = await addNotes(pending.numbers, note);
    await clearPendingNote(chatId);
    await sendFeishuMessage(chatId, reply);
    return;
  }

  if (!text) {
    await sendFeishuMessage(chatId, "如果要把这条消息作为上下文，请先发送：补充 1，然后再转发/发送内容给我");
    return;
  }

  const reply = await handleText(text, chatId);
  await sendFeishuMessage(chatId, reply);
}

async function handleFeishuEvents(request: Request): Promise<Response> {
  const body = await request.json();

  if (body.challenge) {
    return json({ challenge: body.challenge });
  }

  await processFeishuMessage(body);

  return json({ code: 0, msg: "ok" });
}

Deno.serve(async (request: Request) => {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/") {
    return new Response("Feishu todo bot is running");
  }

  if (request.method === "POST" && url.pathname === "/message") {
    const body = await request.json();
    const reply = await handleText(body.text || "");
    return json({ reply });
  }

  if (request.method === "POST" && url.pathname === "/feishu/events") {
    return handleFeishuEvents(request);
  }

  return new Response("Not found", { status: 404 });
});
