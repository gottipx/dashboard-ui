import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";

import { callGateway } from "@/lib/openclaw/gateway-call";
import { runOpenclawCliJson } from "@/lib/openclaw/cli";
import { resolveGatewayRuntime } from "@/lib/openclaw/runtime-config";

export const runtime = "nodejs";

type Body = {
  url?: string;
  token?: string;
  password?: string;
  action?: "list" | "create";
  agent?: {
    id?: string;
    name?: string;
    workspace?: string;
    "default"?: boolean;
  };
};

type RuntimeAgent = {
  id?: string;
  name?: string;
  workspace?: string;
  default?: boolean;
  state?: "ready" | "running" | "down";
  info?: string;
  logs?: string[];
};

function asObject(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" ? (input as Record<string, unknown>) : {};
}

function parseAgents(configPayload: unknown) {
  const payload = asObject(configPayload);
  const value = asObject(payload.value);
  const configNode = asObject(payload.config);
  const config = asObject(configNode.config ?? value.config ?? payload.config ?? payload.value ?? payload);
  const agents = asObject(config.agents);
  const list = Array.isArray(agents.list) ? agents.list : [];
  const meta = asObject(payload.meta);
  const context = asObject(payload.context);
  const hashCandidates = [
    payload.hash,
    payload.baseHash,
    payload.configHash,
    meta.hash,
    context.hash,
    configNode.hash,
    value.hash,
    config.hash,
    agents.hash,
  ];
  const hash = hashCandidates.find((value) => typeof value === "string") as string | undefined;
  return { list, hash };
}

function extractArray(payload: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = payload[key];
    if (Array.isArray(value)) return value;
    if (value && typeof value === "object") {
      const asObject = value as Record<string, unknown>;
      const objectValues = Object.values(asObject);
      if (objectValues.length > 0 && objectValues.every((entry) => entry && typeof entry === "object")) {
        return objectValues;
      }
    }
  }
  return [] as unknown[];
}

function extractSessionItems(sessionsPayload: unknown): Record<string, unknown>[] {
  const payload = asObject(sessionsPayload);
  const items = Array.isArray(payload.items)
    ? payload.items
    : Array.isArray(payload.sessions)
      ? payload.sessions
      : Array.isArray(sessionsPayload)
        ? (sessionsPayload as unknown[])
        : [];
  return items.map((entry) => asObject(entry));
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

function indexSessionsByAgent(items: Record<string, unknown>[]) {
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
    const candidates = [
      row.agent,
      row.agentId,
      row.agent_id,
      row.nodeId,
      row.node_id,
      row.owner,
      row.assignee,
      row.name,
    ]
      .filter((value) => typeof value === "string")
      .map((value) => String(value));
    for (const key of candidates) {
      push(key, line);
    }
  }
  return bucket;
}

function computeStateFromLogs(logs: string[]): RuntimeAgent["state"] {
  if (logs.length === 0) return "ready";
  const joined = logs.join(" ").toLowerCase();
  if (joined.includes("down") || joined.includes("failed") || joined.includes("error")) return "down";
  if (joined.includes("run") || joined.includes("active") || joined.includes("progress") || joined.includes("busy")) return "running";
  return "ready";
}

function pickLogLinesForAgent(source: string[], agent: RuntimeAgent) {
  const idNeedle = agent.id?.trim().toLowerCase() ?? "";
  const nameNeedle = agent.name?.trim().toLowerCase() ?? "";
  if (!idNeedle && !nameNeedle) return [] as string[];
  return source.filter((line) => {
    const lower = line.toLowerCase();
    return (idNeedle && lower.includes(idNeedle)) || (nameNeedle && lower.includes(nameNeedle));
  });
}

function enrichAgentsWithRuntime(agents: RuntimeAgent[], sessionsPayload?: unknown, logTail: string[] = []): RuntimeAgent[] {
  const sessionItems = sessionsPayload ? extractSessionItems(sessionsPayload) : [];
  const sessionsByAgent = indexSessionsByAgent(sessionItems);
  return agents.map((agent) => {
    const idKey = agent.id?.trim().toLowerCase() ?? "";
    const nameKey = agent.name?.trim().toLowerCase() ?? "";
    const sessionLogs = [...(sessionsByAgent.get(idKey) ?? []), ...(sessionsByAgent.get(nameKey) ?? [])];
    const fileLogs = pickLogLinesForAgent(logTail, agent);
    const logs = [...sessionLogs, ...fileLogs].slice(-25);
    const state = agent.state ?? computeStateFromLogs(logs);
    const info =
      agent.info ??
      (agent.workspace ? `Workspace: ${agent.workspace}` : logs.length > 0 ? `${logs.length} runtime entries` : "Connected via OpenClaw");
    return {
      ...agent,
      state,
      info,
      logs,
    };
  });
}

async function callSessionsList(url: string | undefined, auth: { token?: string; password?: string }) {
  try {
    return await callGateway({ url, auth, method: "sessions.list", params: {}, timeoutMs: 10000 });
  } catch {
    try {
      const args = ["gateway", "call", "sessions.list", "--params", "{}"];
      if (url?.trim()) args.push("--url", url.trim());
      if (auth.token) args.push("--token", auth.token);
      if (auth.password) args.push("--password", auth.password);
      return await runOpenclawCliJson(args, 12000);
    } catch {
      return null;
    }
  }
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
      const obj = current as Record<string, unknown>;
      for (const value of Object.values(obj)) stack.push(value);
    }
  }
  return undefined;
}

async function loadGatewayLogTail() {
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

function toAgentsFromUnknown(payload: unknown): RuntimeAgent[] {
  const container = asObject(payload);
  const candidates: unknown[] = [];
  if (Array.isArray(payload)) candidates.push(...payload);
  const arrayKeys = ["items", "agents", "nodes", "list", "data"];
  for (const key of arrayKeys) {
    const value = container[key];
    if (Array.isArray(value)) candidates.push(...value);
  }
  return candidates.map((entry, idx) => {
    const row = asObject(entry);
    return {
      id:
        typeof row.id === "string"
          ? row.id
          : typeof row.agentId === "string"
            ? row.agentId
            : typeof row.agent_id === "string"
              ? row.agent_id
              : typeof row.nodeId === "string"
                ? row.nodeId
                : `agent-${idx + 1}`,
      name:
        typeof row.name === "string"
          ? row.name
          : typeof row.label === "string"
            ? row.label
            : typeof row.title === "string"
              ? row.title
              : typeof row.id === "string"
                ? row.id
                : "OpenClaw Agent",
      workspace: typeof row.workspace === "string" ? row.workspace : undefined,
    };
  });
}

async function cliAgentFallbacks(url?: string, auth?: { token?: string; password?: string }) {
  const base = [] as string[];
  if (url?.trim()) base.push("--url", url.trim());
  if (auth?.token) base.push("--token", auth.token);
  if (auth?.password) base.push("--password", auth.password);
  const attempts: string[][] = [
    ["gateway", "call", "config.get", "--params", "{}", ...base],
    ["gateway", "call", "node.list", "--params", "{}", ...base],
    ["nodes", "status", "--json"],
    ["agents", "list", "--json"],
    ["agent", "list", "--json"],
    ["nodes", "list", "--json"],
  ];
  for (const args of attempts) {
    try {
      const payload = await runOpenclawCliJson(args, 12000);
      const parsed = parseAgents(payload);
      if (parsed.list.length > 0) return parsed.list.map((entry) => asObject(entry));
      const mapped = toAgentsFromUnknown(payload);
      if (mapped.length > 0) return mapped;
    } catch {
      // continue fallback probing
    }
  }
  return [] as RuntimeAgent[];
}

function isHashError(message: string) {
  const text = message.toLowerCase();
  return text.includes("base hash required") || text.includes("hash mismatch") || text.includes("re-run config.get");
}

async function patchAgentsWithRetry(args: {
  url?: string;
  auth: { token?: string; password?: string };
  nextList: unknown[];
  baseHash?: string;
}) {
  const patchPayload: Record<string, unknown> = {
    raw: JSON.stringify({ agents: { list: args.nextList } }),
  };
  if (args.baseHash) patchPayload.baseHash = args.baseHash;
  try {
    return await callGateway({
      url: args.url,
      auth: args.auth,
      method: "config.patch",
      params: patchPayload,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!isHashError(message)) throw error;
    const refreshed = await callGateway({ url: args.url, auth: args.auth, method: "config.get", params: {}, timeoutMs: 10000 });
    const parsed = parseAgents(refreshed);
    const retryPayload: Record<string, unknown> = {
      raw: JSON.stringify({ agents: { list: args.nextList } }),
    };
    if (parsed.hash) retryPayload.baseHash = parsed.hash;
    return await callGateway({
      url: args.url,
      auth: args.auth,
      method: "config.patch",
      params: retryPayload,
    });
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Body;
    const runtime = resolveGatewayRuntime(body);
    const auth = runtime.auth;
    const gatewayUrl = runtime.url;

    if (body.action === "list" || !body.action) {
      const sessionsPayload = await callSessionsList(gatewayUrl, auth);
      const logTail = await loadGatewayLogTail();

      try {
        const cfgPayload = await callGateway({ url: gatewayUrl, auth, method: "config.get", params: {}, timeoutMs: 10000 });
        const cfg = parseAgents(cfgPayload);
        if (cfg.list.length > 0) {
          const normalized: RuntimeAgent[] = cfg.list.map((entry) => {
            const row = asObject(entry);
            return {
              id: typeof row.id === "string" ? row.id : undefined,
              name:
                typeof row.name === "string"
                  ? row.name
                  : typeof row.label === "string"
                    ? row.label
                    : typeof row.id === "string"
                      ? row.id
                      : undefined,
              workspace: typeof row.workspace === "string" ? row.workspace : undefined,
              default: Boolean(row.default),
            };
          });
          return NextResponse.json({ ok: true, agents: enrichAgentsWithRuntime(normalized, sessionsPayload, logTail), source: "config.get" });
        }
      } catch {
        // continue with fallbacks below
      }

      try {
        // fallback for deployments that block config methods or return empty agents list
        const nodesPayload = await callGateway({ url: gatewayUrl, auth, method: "node.list", params: {}, timeoutMs: 10000 });
        const payload = (nodesPayload ?? {}) as Record<string, unknown>;
        const items = Array.isArray(payload.items) ? payload.items : [];
        const agents = items.map((entry, idx) => {
          const row = entry as Record<string, unknown>;
          return {
            id: typeof row.id === "string" ? row.id : `node-${idx + 1}`,
            name: typeof row.name === "string" ? row.name : typeof row.label === "string" ? row.label : "Gateway Node",
            workspace: typeof row.workspace === "string" ? row.workspace : undefined,
          };
        });
        if (agents.length > 0) {
          return NextResponse.json({
            ok: true,
            agents: enrichAgentsWithRuntime(agents, sessionsPayload, logTail),
            source: "node.list",
            warning: "config.get had no agents; using node.list.",
          });
        }
      } catch {
        // continue with fallbacks below
      }

      try {
        const cliNodesPayload = await runOpenclawCliJson(["nodes", "status", "--json"], 12000);
        const payload = (cliNodesPayload ?? {}) as Record<string, unknown>;
        const items = Array.isArray(payload.items)
          ? payload.items
          : Array.isArray(payload.nodes)
            ? payload.nodes
            : Array.isArray(cliNodesPayload)
              ? (cliNodesPayload as unknown[])
              : [];
        const agents = items.map((entry, idx) => {
          const row = entry as Record<string, unknown>;
          return {
            id:
              typeof row.id === "string"
                ? row.id
                : typeof row.nodeId === "string"
                  ? row.nodeId
                  : `node-${idx + 1}`,
            name:
              typeof row.name === "string"
                ? row.name
                : typeof row.label === "string"
                  ? row.label
                  : typeof row.id === "string"
                    ? row.id
                    : "Gateway Node",
            workspace: typeof row.workspace === "string" ? row.workspace : undefined,
          };
        });
        if (agents.length > 0) {
          return NextResponse.json({
            ok: true,
            agents: enrichAgentsWithRuntime(agents, sessionsPayload, logTail),
            source: "nodes.status",
            warning: "config.get/node.list had no agents; using nodes status.",
          });
        }
      } catch {
        // continue with presence fallback below
      }

      // final fallback using presence
      const presencePayload = await callGateway({
        url: gatewayUrl,
        auth,
        method: "system-presence",
        params: {},
        timeoutMs: 10000,
      });
      const payload = (presencePayload ?? {}) as Record<string, unknown>;
      const items = extractArray(payload, ["items", "devices", "peers", "nodes", "presence"]);
      const agents: RuntimeAgent[] = [];
      for (const [idx, entry] of items.entries()) {
        const row = entry as Record<string, unknown>;
        const roles = Array.isArray(row.roles) ? row.roles.map(String) : [];
        if (roles.length > 0 && !roles.includes("node") && !roles.includes("agent") && !roles.includes("worker")) continue;
        agents.push({
          id:
            typeof row.deviceId === "string"
              ? row.deviceId
              : typeof row.id === "string"
                ? row.id
                : typeof row.nodeId === "string"
                  ? row.nodeId
                  : `presence-${idx + 1}`,
          name:
            typeof row.name === "string"
              ? row.name
              : typeof row.label === "string"
                ? row.label
                : typeof row.title === "string"
                  ? row.title
                  : typeof row.deviceId === "string"
                    ? row.deviceId
                    : "Gateway Presence",
          workspace: undefined,
        });
      }
      if (agents.length === 0) {
        const cliAgents = await cliAgentFallbacks(gatewayUrl, auth);
        if (cliAgents.length > 0) {
          return NextResponse.json({
            ok: true,
            agents: enrichAgentsWithRuntime(cliAgents, sessionsPayload, logTail),
            source: "cli.fallback",
            warning: "Using CLI fallback source for agent inventory.",
          });
        }
      }
      if (agents.length === 0) {
        return NextResponse.json({
          ok: true,
          agents: [],
          source: "none",
          warning: "No agents discovered from gateway or CLI sources.",
        });
      }
      return NextResponse.json({
        ok: true,
        agents: enrichAgentsWithRuntime(agents, sessionsPayload, logTail),
        source: "system-presence",
        warning: "config.get/node.list/nodes.status had no agents; showing presence entries.",
      });
    }

    if (body.action === "create") {
      const cfgPayload = await callGateway({ url: gatewayUrl, auth, method: "config.get", params: {}, timeoutMs: 10000 });
      const cfg = parseAgents(cfgPayload);
      const id = body.agent?.id?.trim();
      const name = body.agent?.name?.trim();
      const workspace = body.agent?.workspace?.trim();

      if (!id || !name) {
        return NextResponse.json({ error: "Missing agent id or name." }, { status: 400 });
      }
      const exists = cfg.list.some((entry) => {
        const value = entry as Record<string, unknown>;
        return value.id === id;
      });
      if (exists) {
        return NextResponse.json({ error: `Agent ${id} already exists.` }, { status: 409 });
      }

      const nextAgent = {
        id,
        name,
        workspace: workspace || undefined,
        default: Boolean(body.agent?.default),
      };
      const nextList = [...cfg.list, nextAgent];
      const patchResult = await patchAgentsWithRetry({
        url: gatewayUrl,
        auth,
        nextList,
        baseHash: cfg.hash,
      });

      return NextResponse.json({ ok: true, agent: nextAgent, patch: patchResult });
    }

    return NextResponse.json({ error: "Unsupported action." }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Gateway agents API failed";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
