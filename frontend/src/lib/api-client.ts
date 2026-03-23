import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import { TodoService } from "../gen/todo/v1/todo_pb";

const transport = createConnectTransport({
  baseUrl: import.meta.env?.VITE_API_URL ?? "http://localhost:8080",
});

export const todoClient = createClient(TodoService, transport);
