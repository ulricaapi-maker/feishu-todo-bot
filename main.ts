declare const EdgeRuntime: { waitUntil: (promise: Promise<unknown>) => void };

type Todo = {
  text: string;
  done: boolean;
  createdAt: string;
  doneAt?: string;
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

async function readTodos(): Promise<Todo[]> {
  const kv = await Deno.openKv();
  const result = await kv.get<Todo[]>(["todos"]);
  return result.value || [];
}

async function writeTodos(todos: Todo[]): Promise<void> {
  const kv = await Deno.openKv();
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

async function handleText(text: string): Promise<string> {
  const trimmed = text.trim();

  if (trimmed === "列表") {
    return formatTodoList();
  }

  if (trimmed === "清空") {
    return clearTodos();
  }

  if (trimmed.startsWith("完成 ")) {
    const number = Number(trimmed.replace("完成 ", ""));
    return doneTodo(number);
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
  const kv = await Deno.openKv();
  await kv.set(["settings", "chatId"], chatId);
}

async function getSavedChatId(): Promise<string | null> {
  const kv = await Deno.openKv();
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
  const text = getTextFromFeishuMessage(message);

  if (!chatId || !text) {
    return;
  }

  await saveChatId(chatId);
  const reply = await handleText(text);
  await sendFeishuMessage(chatId, reply);
}

async function handleFeishuEvents(request: Request): Promise<Response> {
  const body = await request.json();

  if (body.challenge) {
    return json({ challenge: body.challenge });
  }

  EdgeRuntime.waitUntil(processFeishuMessage(body));

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
