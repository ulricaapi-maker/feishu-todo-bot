require("dotenv").config();

const express = require("express");
const {
  addTodo,
  formatTodoList,
  doneTodo,
  clearTodos,
} = require("./todo");

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

app.get("/", (req, res) => {
  res.send("Feishu todo bot is running");
});

function handleText(text) {
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

function getTextFromFeishuMessage(message) {
  if (!message || message.message_type !== "text") {
    return "";
  }

  try {
    const content = JSON.parse(message.content || "{}");
    return content.text || "";
  } catch (error) {
    return "";
  }
}

async function getTenantAccessToken() {
  const response = await fetch(
    "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        app_id: process.env.FEISHU_APP_ID,
        app_secret: process.env.FEISHU_APP_SECRET,
      }),
    }
  );

  const data = await response.json();

  if (data.code !== 0) {
    console.log("获取飞书访问令牌失败：");
    console.log(data);
    return null;
  }

  return data.tenant_access_token;
}

async function sendFeishuMessage(chatId, text) {
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
    }
  );

  const data = await response.json();

  if (data.code !== 0) {
    console.log("发送飞书消息失败：");
    console.log(data);
  }
}

app.post("/message", (req, res) => {
  const text = req.body.text || "";
  const reply = handleText(text);

  res.json({
    reply,
  });
});

app.post("/feishu/events", async (req, res) => {
  console.log("收到飞书事件：");
  console.log(JSON.stringify(req.body, null, 2));

  if (req.body.challenge) {
    res.json({
      challenge: req.body.challenge,
    });
    return;
  }

  res.json({
    code: 0,
    msg: "ok",
  });

  const message = req.body.event && req.body.event.message;
  const chatId = message && message.chat_id;
  const text = getTextFromFeishuMessage(message);

  if (!chatId || !text) {
    return;
  }

  const reply = handleText(text);
  await sendFeishuMessage(chatId, reply);
});

app.listen(port, () => {
  console.log("机器人服务已启动，端口：" + port);
});
