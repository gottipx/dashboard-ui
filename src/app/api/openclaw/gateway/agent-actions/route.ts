import { NextResponse } from "next/server";

import { callGateway } from "@/lib/openclaw/gateway-call";
import { resolveGatewayRuntime } from "@/lib/openclaw/runtime-config";

export const runtime = "nodejs";

type Body = {
  action?: "sessions" | "chat" | "dispatch-task";
  agentId?: string;
  message?: string;
  task?: {
    id?: string;
    title?: string;
    description?: string;
    project?: string;
    priority?: string;
    status?: string;
    agent?: string;
  };
};

function asObject(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" ? (input as Record<string, unknown>) : {};
}

function extractSessions(payload: unknown) {
  const source = asObject(payload);
  const items = Array.isArray(source.items)
    ? source.items
    : Array.isArray(source.sessions)
      ? source.sessions
      : Array.isArray(payload)
        ? payload
        : [];
  return items.map((entry) => asObject(entry));
}

function includesAgent(row: Record<string, unknown>, agentId: string) {
  const needle = agentId.trim().toLowerCase();
  if (!needle) return true;
  const candidates = [
    row.agent,
    row.agentId,
    row.agent_id,
    row.nodeId,
    row.node_id,
    row.owner,
    row.assignee,
    row.name,
    row.id,
    row.key,
  ]
    .filter((value) => typeof value === "string")
    .map((value) => String(value).toLowerCase());
  return candidates.some((value) => value.includes(needle));
}

async function tryMethods(args: {
  url?: string;
  auth: { token?: string; password?: string };
  methods: string[];
  payloadBuilder: (method: string) => Record<string, unknown>;
  timeoutMs?: number;
}) {
  const errors: string[] = [];
  for (const method of args.methods) {
    try {
      const payload = await callGateway({
        url: args.url,
        auth: args.auth,
        method,
        params: args.payloadBuilder(method),
        timeoutMs: args.timeoutMs ?? 20000,
      });
      return { method, payload };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${method}: ${message.split("\n")[0]}`);
    }
  }
  throw new Error(`No supported gateway method succeeded. Tried: ${errors.join(" | ")}`);
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Body;
    const runtime = resolveGatewayRuntime({});
    const auth = runtime.auth;
    const url = runtime.url;

    if (body.action === "sessions") {
      const payload = await callGateway({ url, auth, method: "sessions.list", params: {}, timeoutMs: 12000 });
      const sessions = extractSessions(payload);
      const filtered = body.agentId?.trim()
        ? sessions.filter((row) => includesAgent(row, body.agentId!))
        : sessions;
      return NextResponse.json({ ok: true, sessions: filtered });
    }

    if (body.action === "chat") {
      const message = body.message?.trim();
      if (!message) {
        return NextResponse.json({ error: "Message is required." }, { status: 400 });
      }
      const agentId = body.agentId?.trim() || undefined;
      const result = await tryMethods({
        url,
        auth,
        methods: ["agent.chat", "agent.message", "chat.send", "session.message", "assistant.message"],
        payloadBuilder: () => ({
          agentId,
          agent: agentId,
          nodeId: agentId,
          id: agentId,
          message,
          text: message,
          prompt: message,
          input: message,
        }),
        timeoutMs: 45000,
      });
      return NextResponse.json({ ok: true, method: result.method, payload: result.payload });
    }

    if (body.action === "dispatch-task") {
      const task = body.task ?? {};
      const agentId = (body.agentId || task.agent || "").trim();
      const title = (task.title || "").trim();
      if (!agentId || !title) {
        return NextResponse.json({ error: "Task title and target agent are required." }, { status: 400 });
      }
      const result = await tryMethods({
        url,
        auth,
        methods: ["task.create", "tasks.create", "agent.task", "agent.assign", "work.enqueue"],
        payloadBuilder: () => ({
          agentId,
          agent: agentId,
          nodeId: agentId,
          task: {
            id: task.id,
            title,
            description: task.description || "",
            project: task.project || "",
            priority: task.priority || "Medium",
            status: task.status || "Todo",
          },
          title,
          description: task.description || "",
          project: task.project || "",
          priority: task.priority || "Medium",
        }),
      });
      return NextResponse.json({ ok: true, method: result.method, payload: result.payload });
    }

    return NextResponse.json({ error: "Unsupported action." }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Agent actions failed";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

