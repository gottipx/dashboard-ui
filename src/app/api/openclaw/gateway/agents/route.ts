import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";

import { runOpenclawCliJson } from "@/lib/openclaw/cli";

export const runtime = "nodejs";

type Body = {
  action?: "list" | "create";
  agent?: {
    id?: string;
    name?: string;
    workspace?: string;
  };
};

type RuntimeAgent = {
  id?: string;
  name?: string;
  workspace?: string;
  state?: "ready" | "running" | "down";
  info?: string;
  logs?: string[];
};

function asObject(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" ? (input as Record<string, unknown>) : {};
}

function toArray(payload: unknown, keys: string[]) {
  const obj = asObject(payload);
  for (const key of keys) {
    const value = obj[key];
    if (Array.isArray(value)) return value;
  }
  return Array.isArray(payload) ? payload : [];
}

function normalizeAgentsFromPayload(payload: unknown): RuntimeAgent[] {
  const items = toArray(payload, ["items", "agents", "list", "nodes"]);
  return items.map((entry, idx) => {
    const row = asObject(entry);
    return {
      id:
        typeof row.id === "string"
          ? row.id
          : typeof row.agentId === "string"
            ? row.agentId
            : typeof row.nodeId === "string"
              ? row.nodeId
              : `agent-${idx + 1}`,
      name:
        typeof row.name === "string"
          ? row.name
          : typeof row.label === "string"
            ? row.label
            : typeof row.id === "string"
              ? row.id
              : `Agent ${idx + 1}`,
      workspace:
        typeof row.workspace === "string"
          ? row.workspace
          : typeof row.workspacePath === "string"
            ? row.workspacePath
            : undefined,
    };
  });
}

function toIsoTime(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(11, 19);
}

function sessionLine(row: Record<string, unknown>) {
  const timestamp =
    toIsoTime(row.updatedAt ?? row.updated_at ?? row.lastSeenAt ?? row.last_seen_at ?? row.createdAt ?? row.created_at) || "runtime";
  const state = String(row.state ?? row.status ?? row.phase ?? "active");
  const key = String(row.key ?? row.id ?? row.sessionId ?? row.session_id ?? "session");
  return `${timestamp} ${state} (${key})`;
}

function indexSessionsByAgent(sessionsPayload: unknown) {
  const items = toArray(sessionsPayload, ["items", "sessions"]).map((entry) => asObject(entry));
  const bucket = new Map<string, string[]>();
  const push = (key: string, line: string) => {
    const normalized = key.trim().toLowerCase();
    if (!normalized) return;
    const current = bucket.get(normalized) ?? [];
    current.push(line);
    bucket.set(normalized, current);
  };
  for (const row of items) {
    const line = sessionLine(row);
    const candidates = [row.agent, row.agentId, row.agent_id, row.nodeId, row.node_id, row.owner, row.assignee, row.name]
      .filter((value) => typeof value === "string")
      .map((value) => String(value));
    for (const key of candidates) push(key, line);
  }
  return bucket;
}

function extractFirstLogPath(payload: unknown): string | undefined {
  const stack: unknown[] = [payload];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    if (typeof current === "string") {
      const looksLikeLog = current.includes(".log") && (current.includes("/tmp/") || current.includes("/var/") || current.includes("/home/"));
      if (looksLikeLog) return current;
      continue;
    }
    if (Array.isArray(current)) {
      for (const item of current) stack.push(item);
      continue;
    }
    if (typeof current === "object") {
      for (const value of Object.values(current as Record<string, unknown>)) stack.push(value);
    }
  }
  return undefined;
}

async function loadCliLogTail() {
  try {
    const statusPayload = await runOpenclawCliJson(["status", "--json"], 10000);
    const logPath = extractFirstLogPath(statusPayload);
    if (!logPath) return [] as string[];
    const content = await readFile(logPath, "utf8");
    return content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-400);
  } catch {
    return [] as string[];
  }
}

function computeStateFromLogs(logs: string[]): RuntimeAgent["state"] {
  if (logs.length === 0) return "ready";
  const joined = logs.join(" ").toLowerCase();
  if (joined.includes("down") || joined.includes("failed") || joined.includes("error")) return "down";
  if (joined.includes("run") || joined.includes("active") || joined.includes("progress") || joined.includes("busy")) return "running";
  return "ready";
}

function enrichAgents(agents: RuntimeAgent[], sessionsPayload: unknown, logTail: string[]): RuntimeAgent[] {
  const sessionsByAgent = indexSessionsByAgent(sessionsPayload);
  return agents.map((agent) => {
    const idKey = agent.id?.trim().toLowerCase() ?? "";
    const nameKey = agent.name?.trim().toLowerCase() ?? "";
    const sessionLogs = [...(sessionsByAgent.get(idKey) ?? []), ...(sessionsByAgent.get(nameKey) ?? [])];
    const fileLogs = logTail.filter((line) => {
      const lower = line.toLowerCase();
      return (idKey && lower.includes(idKey)) || (nameKey && lower.includes(nameKey));
    });
    const merged = fileLogs.length > 0 ? [...sessionLogs, ...fileLogs] : [...sessionLogs, ...logTail];
    const logs = merged.slice(-120);
    const state = computeStateFromLogs(logs);
    return {
      ...agent,
      state,
      info: agent.workspace ? `Workspace: ${agent.workspace}` : logs.length > 0 ? `${logs.length} runtime entries` : "Connected via OpenClaw CLI",
      logs,
    };
  });
}

async function firstSuccessfulCli<T = unknown>(attempts: string[][]) {
  const errors: string[] = [];
  for (const args of attempts) {
    try {
      return { payload: (await runOpenclawCliJson(args, 12000)) as T, source: args.join(" ") };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${args.join(" ")}: ${message.split("\n")[0]}`);
    }
  }
  return { payload: null as T | null, source: "none", error: errors.join(" | ") };
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Body;

    if (body.action === "create") {
      const id = body.agent?.id?.trim();
      const name = body.agent?.name?.trim();
      const workspace = body.agent?.workspace?.trim();
      if (!id || !name) {
        return NextResponse.json({ error: "Missing agent id or name." }, { status: 400 });
      }
      const attempts: string[][] = [
        ["agents", "add", "--id", id, "--name", name, ...(workspace ? ["--workspace", workspace] : []), "--json"],
        ["agent", "add", "--id", id, "--name", name, ...(workspace ? ["--workspace", workspace] : []), "--json"],
        ["agent", "create", "--id", id, "--name", name, ...(workspace ? ["--workspace", workspace] : []), "--json"],
      ];
      const result = await firstSuccessfulCli(attempts);
      if (!result.payload) {
        return NextResponse.json(
          { error: `Agent creation failed via CLI. Tried: ${result.error}` },
          { status: 500 }
        );
      }
      return NextResponse.json({ ok: true, agent: { id, name, workspace }, source: result.source, payload: result.payload });
    }

    const [agentResult, nodesResult, sessionsResult, logTail] = await Promise.all([
      firstSuccessfulCli([["agents", "list", "--json"], ["agent", "list", "--json"]]),
      firstSuccessfulCli([["nodes", "status", "--json"], ["nodes", "list", "--json"]]),
      firstSuccessfulCli([["sessions", "list", "--json"], ["session", "list", "--json"]]),
      loadCliLogTail(),
    ]);

    const fromAgents = agentResult.payload ? normalizeAgentsFromPayload(agentResult.payload) : [];
    const fromNodes = nodesResult.payload ? normalizeAgentsFromPayload(nodesResult.payload) : [];
    const baseAgents = fromAgents.length > 0 ? fromAgents : fromNodes;
    const sessionsPayload = sessionsResult.payload ?? { items: [] };
    const enriched = enrichAgents(baseAgents, sessionsPayload, logTail);

    if (enriched.length === 0) {
      return NextResponse.json({
        ok: true,
        agents: [],
        source: "none",
        warning: "No agents discovered from OpenClaw CLI commands.",
      });
    }

    return NextResponse.json({
      ok: true,
      agents: enriched,
      source: fromAgents.length > 0 ? agentResult.source : nodesResult.source,
      warning: fromAgents.length > 0 ? undefined : "Agent inventory resolved from node status fallback.",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "OpenClaw agents CLI failed";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
