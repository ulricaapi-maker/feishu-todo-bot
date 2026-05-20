const fs = require("fs");
const path = require("path");

const file = process.env.TODOS_FILE || path.join(__dirname, "todos.json");

function readTodos() {
  if (!fs.existsSync(file)) {
    return [];
  }

  const content = fs.readFileSync(file, "utf8");

  if (!content.trim()) {
    return [];
  }

  return JSON.parse(content);
}

function writeTodos(todos) {
  fs.writeFileSync(file, JSON.stringify(todos, null, 2), "utf8");
}

function addTodo(text) {
  const todos = readTodos();

  const todo = {
    text,
    done: false,
    createdAt: new Date().toISOString(),
  };

  todos.push(todo);
  writeTodos(todos);

  return "已添加待办：" + text;
}

function getOpenTodos() {
  return readTodos().filter((todo) => !todo.done);
}

function formatTodoList() {
  const openTodos = getOpenTodos();

  if (openTodos.length === 0) {
    return "目前没有待办";
  }

  const lines = ["待办清单："];

  openTodos.forEach((todo, index) => {
    lines.push(index + 1 + ". " + todo.text);
  });

  return lines.join("\n");
}

function doneTodo(number) {
  const todos = readTodos();
  const openTodos = todos.filter((todo) => !todo.done);
  const todo = openTodos[number - 1];

  if (!todo) {
    return "没有找到这个编号的待办";
  }

  todo.done = true;
  todo.doneAt = new Date().toISOString();

  writeTodos(todos);

  return "已完成：" + todo.text;
}

function clearTodos() {
  const todos = readTodos();

  todos.forEach((todo) => {
    if (!todo.done) {
      todo.done = true;
      todo.doneAt = new Date().toISOString();
    }
  });

  writeTodos(todos);

  return "已清空所有未完成待办";
}

function runCli() {
  const command = process.argv[2];
  const value = process.argv.slice(3).join(" ");

  if (command === "add") {
    if (!value) {
      console.log("请写要添加的待办内容");
      return;
    }

    console.log(addTodo(value));
    return;
  }

  if (command === "list") {
    console.log(formatTodoList());
    return;
  }

  if (command === "done") {
    console.log(doneTodo(Number(value)));
    return;
  }

  if (command === "clear") {
    console.log(clearTodos());
    return;
  }

  console.log("可用命令：");
  console.log('node todo.js add "待办内容"');
  console.log("node todo.js list");
  console.log("node todo.js done 1");
  console.log("node todo.js clear");
}

if (require.main === module) {
  runCli();
}

module.exports = {
  addTodo,
  formatTodoList,
  doneTodo,
  clearTodos,
};