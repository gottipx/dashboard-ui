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

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Body;

    if (body.action === "sessions") {
      const result = await firstSuccessfulCli([["sessions", "list", "--json"], ["session", "list", "--json"]]);
      const sessions = extractSessions(result.payload);
      const filtered = body.agentId?.trim() ? sessions.filter((row) => includesAgent(row, body.agentId!)) : sessions;
      return NextResponse.json({ ok: true, sessions: filtered, source: result.source });
    }

    if (body.action === "chat") {
      const message = body.message?.trim();
      const agentId = body.agentId?.trim();
      if (!message || !agentId) {
        return NextResponse.json({ error: "Agent and message are required." }, { status: 400 });
      }
      const result = await firstSuccessfulCli([
        ["agent", "chat", "--id", agentId, "--message", message, "--json"],
        ["agents", "chat", "--id", agentId, "--message", message, "--json"],
        ["chat", "--agent", agentId, "--message", message, "--json"],
      ]);
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
      const result = await firstSuccessfulCli([
        ["tasks", "create", "--agent", agentId, "--title", title, "--description", description, "--json"],
        ["task", "create", "--agent", agentId, "--title", title, "--description", description, "--json"],
        ["agent", "task", "--id", agentId, "--title", title, "--description", description, "--json"],
      ]);
      return NextResponse.json({ ok: true, payload: result.payload, source: result.source });
    }

    return NextResponse.json({ error: "Unsupported action." }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Agent actions CLI failed";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

