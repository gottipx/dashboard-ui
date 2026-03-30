import { NextResponse } from "next/server";

import { runOpenclawCliJson } from "@/lib/openclaw/cli";

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
  const root = asObject(payload);
  const source = asObject(root.payload ?? root.data ?? payload);
  const items = Array.isArray(source.items)
    ? source.items
    : Array.isArray(source.sessions)
      ? source.sessions
      : Array.isArray(source.entries)
        ? source.entries
      : Array.isArray(payload)
        ? payload
        : [];
  return items.map((entry) => asObject(entry));
}

function includesAgent(row: Record<string, unknown>, agentId: string) {
  const needle = agentId.trim().toLowerCase();
  if (!needle) return true;
  const candidates = [row.agent, row.agentId, row.agent_id, row.nodeId, row.node_id, row.owner, row.assignee, row.name, row.id, row.key]
    .filter((value) => typeof value === "string")
    .map((value) => String(value).toLowerCase());
  return candidates.some((value) => value.includes(needle));
}

async function firstSuccessfulCli(attempts: string[][]) {
  const errors: string[] = [];
  for (const args of attempts) {
    try {
      return { payload: await runOpenclawCliJson(args, 45000), source: args.join(" ") };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${args.join(" ")}: ${message.split("\n")[0]}`);
    }
  }
  throw new Error(`No supported OpenClaw CLI command succeeded. Tried: ${errors.join(" | ")}`);
}

async function firstSuccessfulCliOptional(attempts: string[][]) {
  const errors: string[] = [];
  for (const args of attempts) {
    try {
      return { payload: await runOpenclawCliJson(args, 45000), source: args.join(" "), error: undefined as string | undefined };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${args.join(" ")}: ${message.split("\n")[0]}`);
    }
  }
  return { payload: null, source: "none", error: errors.join(" | ") };
}

async function firstSuccessfulGatewayCall(methods: string[], params: Record<string, unknown>) {
  const attempts = methods.map((method) => ["gateway", "call", method, "--params", JSON.stringify(params)]);
  return await firstSuccessfulCli(attempts);
}

async function firstSuccessfulGatewayCallOptional(methods: string[], params: Record<string, unknown>) {
  const attempts = methods.map((method) => ["gateway", "call", method, "--params", JSON.stringify(params)]);
  return await firstSuccessfulCliOptional(attempts);
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Body;

    if (body.action === "sessions") {
      const gatewayResult = await firstSuccessfulGatewayCallOptional(["sessions.list", "session.list"], {});
      const cliResult = await firstSuccessfulCliOptional([
        ["sessions", "--all-agents", "--json"],
        ["sessions", "--json"],
        ["session", "list", "--json"],
      ]);
      const payload = cliResult.payload ?? gatewayResult.payload;
      const sessions = payload ? extractSessions(payload) : [];
      const filtered = body.agentId?.trim() ? sessions.filter((row) => includesAgent(row, body.agentId!)) : sessions;
      return NextResponse.json({
        ok: true,
        sessions: filtered,
        source: cliResult.payload ? cliResult.source : gatewayResult.source,
        warning:
          !gatewayResult.payload && !cliResult.payload
            ? `Sessions unavailable via CLI/gateway-call. ${gatewayResult.error || ""} ${cliResult.error || ""}`.trim()
            : undefined,
      });
    }

    if (body.action === "chat") {
      const message = body.message?.trim();
      const agentId = body.agentId?.trim();
      if (!message || !agentId) {
        return NextResponse.json({ error: "Agent and message are required." }, { status: 400 });
      }
      const cliResult = await firstSuccessfulCliOptional([
        ["agent", "--agent", agentId, "--message", message, "--json"],
        ["agent", "--agent", agentId, "--message", message],
      ]);
      if (cliResult.payload) {
        return NextResponse.json({ ok: true, payload: cliResult.payload, source: cliResult.source });
      }
      const result = await firstSuccessfulGatewayCall(
        ["agent.chat", "agent.message", "session.message", "chat.send", "assistant.message"],
        {
          agentId,
          agent: agentId,
          nodeId: agentId,
          id: agentId,
          message,
          text: message,
          prompt: message,
          input: message,
        }
      );
      return NextResponse.json({ ok: true, payload: result.payload, source: result.source });
    }

    if (body.action === "dispatch-task") {
      const task = body.task ?? {};
      const agentId = (body.agentId || task.agent || "").trim();
      const title = (task.title || "").trim();
      if (!agentId || !title) {
        return NextResponse.json({ error: "Task title and target agent are required." }, { status: 400 });
      }
      const description = task.description || "";
      const result = await firstSuccessfulGatewayCall(
        ["task.create", "tasks.create", "agent.task", "agent.assign", "work.enqueue"],
        {
          agentId,
          agent: agentId,
          nodeId: agentId,
          task: {
            id: task.id,
            title,
            description,
            project: task.project || "",
            priority: task.priority || "Medium",
            status: task.status || "Todo",
          },
          title,
          description,
          project: task.project || "",
          priority: task.priority || "Medium",
          status: task.status || "Todo",
        }
      );
      return NextResponse.json({ ok: true, payload: result.payload, source: result.source });
    }

    return NextResponse.json({ error: "Unsupported action." }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Agent actions CLI failed";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
