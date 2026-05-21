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

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function parseTodoNumbers(value: string): number[] {
  return value
    .split(/[，,、\s]+/)
    .map((item) => Number(item.trim()))
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

async function summarizeWithAI(title: string, rawText: string): Promise<string | null> {
  const apiKey = Deno.env.get("OPENAI_API_KEY");

  if (!apiKey || !rawText.trim()) {
    return null;
  }

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-5.4-mini",
      instructions: [
        "你是一个飞书待办上下文整理助手。",
        "请把用户转发的聊天记录、富文本、文件说明或普通文字整理成简短中文摘要。",
        "输出要适合作为待办事项的上下文，不要寒暄，不要编造。",
        "如果能看出行动项、负责人、截止时间、字段名、争议点，请优先提取。",
        "最多 5 条，每条不超过 40 个中文字符。",
      ].join("\n"),
      input: "标题：" + title + "\n\n原始内容：\n" + truncate(rawText, 6000),
    }),
  });

  const data = await response.json();

  if (!response.ok || data.error) {
    console.log("AI 摘要失败：", data.error || data);
    return null;
  }

  const text = data.output_text || data.output?.flatMap((item: any) => item.content || [])
    ?.map((content: any) => content.text || "")
    ?.join("\n")
    ?.trim();

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
    const content = JSON.parse(message?.content || "{}");

    if (messageType === "text") {
      const text = content.text || "";
      const aiSummary = await summarizeWithAI("普通文字", text);
      return aiSummary || text;
    }

    if (messageType === "post") {
      const title = content.title ? "富文本 - " + content.title : "富文本";
      const lines = collectReadableText(content.content);
      const rawText = lines.join("\n");
      const aiSummary = await summarizeWithAI(title, rawText);
      return aiSummary || formatReadableSummary("富文本摘要", lines, "收到一条富文本消息");
    }

    if (["merge_forward", "forward", "chat_history"].includes(messageType)) {
      const lines = collectReadableText(content);
      const rawText = lines.join("\n");
      const aiSummary = await summarizeWithAI("转发聊天记录", rawText);
      return aiSummary || formatReadableSummary(
        "转发聊天记录摘要",
        lines,
        "收到一条转发聊天记录。\nmessage_id: " + messageId,
      );
    }

    if (messageType === "image") {
      return "图片上下文：收到一张图片。\nmessage_id: " + messageId;
    }

    if (messageType === "file") {
      const name = content.file_name || content.name || "未命名文件";
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
