import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";

import { runOpenclawCliJson } from "@/lib/openclaw/cli";

export type BridgeAgent = {
  id: string;
  name: string;
  workspace?: string;
  state: "ready" | "running" | "down";
  info: string;
  logs: string[];
};

export type BridgeSession = {
  id: string;
  key: string;
  state: string;
  agent?: string;
  updatedAt?: string;
};

export type BridgeRun = {
  id: string;
  kind: "chat" | "task" | "issue" | "project";
  agentId: string;
  title: string;
  status: "queued" | "running" | "completed" | "failed";
  createdAt: string;
  updatedAt: string;
  input?: unknown;
  output?: unknown;
  error?: string;
};

export type BridgeState = {
  version: number;
  syncing: boolean;
  connected: boolean;
  lastSyncAt: string | null;
  connectionTarget: string;
  sourceStatus: string;
  warnings: string[];
  agents: BridgeAgent[];
  sessions: BridgeSession[];
  logs: {
    source: string;
    lines: string[];
  };
  runs: BridgeRun[];
};

function asObject(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" ? (input as Record<string, unknown>) : {};
}

function extractArrayShallow(payload: unknown, keys: string[]) {
  const root = asObject(payload);
  const node = asObject(root.payload ?? root.data ?? payload);
  for (const key of keys) {
    const value = node[key];
    if (Array.isArray(value)) return value;
  }
  if (Array.isArray(node.result)) return node.result;
  if (Array.isArray(node.results)) return node.results;
  if (Array.isArray(payload)) return payload;
  return [] as unknown[];
}

function deepCollectArrays(payload: unknown, predicate: (row: Record<string, unknown>) => boolean) {
  const queue: unknown[] = [payload];
  const found: Record<string, unknown>[] = [];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    if (Array.isArray(current)) {
      for (const item of current) {
        const row = asObject(item);
        if (Object.keys(row).length > 0 && predicate(row)) {
          found.push(row);
        }
        queue.push(item);
      }
      continue;
    }
    if (typeof current === "object") {
      for (const value of Object.values(current as Record<string, unknown>)) queue.push(value);
    }
  }
  return found;
}

function toIso(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString();
}

function parseLogTimestamp(line: string) {
  const isoMatch = line.match(/\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/);
  if (isoMatch) {
    const d = new Date(isoMatch[0].replace(" ", "T"));
    if (!Number.isNaN(d.getTime())) return d.getTime();
  }
  return undefined;
}

function extractFirstLogPath(payload: unknown): string | undefined {
  const stack: unknown[] = [payload];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    if (typeof current === "string") {
      if (current.includes(".log") && (current.includes("/tmp/") || current.includes("/var/") || current.includes("/home/"))) return current;
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

async function firstSuccessfulCli(attempts: string[][], timeoutMs = 20000) {
  const errors: string[] = [];
  for (const args of attempts) {
    try {
      return { ok: true as const, source: args.join(" "), payload: await runOpenclawCliJson(args, timeoutMs) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${args.join(" ")}: ${message.split("\n")[0]}`);
    }
  }
  return { ok: false as const, source: "none", payload: null, error: errors.join(" | ") };
}

function extractChatText(payload: unknown) {
  const root = asObject(payload);
  const direct = typeof root.text === "string" ? root.text : typeof root.content === "string" ? root.content : "";
  if (direct) return direct;
  const result = asObject(root.result ?? root.payload ?? root.data ?? root);
  const payloads = Array.isArray(result.payloads) ? result.payloads : [];
  for (const entry of payloads) {
    const row = asObject(entry);
    if (typeof row.text === "string" && row.text.trim()) return row.text;
    if (typeof row.content === "string" && row.content.trim()) return row.content;
  }
  return JSON.stringify(payload ?? {}, null, 2);
}

export class OpenclawBridge {
  private state: BridgeState = {
    version: 0,
    syncing: false,
    connected: false,
    lastSyncAt: null,
    connectionTarget: process.env.OPENCLAW_GATEWAY_CLI_BIN || "openclaw",
    sourceStatus: "idle",
    warnings: [],
    agents: [],
    sessions: [],
    logs: {
      source: "none",
      lines: [],
    },
    runs: [],
  };

  private emitter = new EventEmitter();
  private syncPromise: Promise<BridgeState> | null = null;

  snapshot() {
    return this.state;
  }

  private publish() {
    this.state = {
      ...this.state,
      version: this.state.version + 1,
    };
    this.emitter.emit("update", this.state);
  }

  subscribe(listener: (state: BridgeState) => void) {
    this.emitter.on("update", listener);
    return () => this.emitter.off("update", listener);
  }

  private setPartial(partial: Partial<BridgeState>) {
    this.state = { ...this.state, ...partial };
    this.publish();
  }

  private buildSessions(payload: unknown): BridgeSession[] {
    const baseItems = extractArrayShallow(payload, ["items", "sessions", "entries", "list", "values"]);
    const deepItems = deepCollectArrays(payload, (row) =>
      ["id", "sessionId", "key", "state", "status", "agent", "agentId", "nodeId"].some((k) => k in row)
    );
    const all = [...baseItems.map((entry) => asObject(entry)), ...deepItems];
    const uniq = new Map<string, BridgeSession>();
    for (const row of all) {
      const id = typeof row.id === "string" ? row.id : typeof row.sessionId === "string" ? row.sessionId : "";
      const key = typeof row.key === "string" ? row.key : typeof row.name === "string" ? row.name : id || "session";
      const state = typeof row.state === "string" ? row.state : typeof row.status === "string" ? row.status : "unknown";
      const agent =
        typeof row.agent === "string"
          ? row.agent
          : typeof row.agentId === "string"
            ? row.agentId
            : typeof row.nodeId === "string"
              ? row.nodeId
              : undefined;
      const updatedAt = toIso(row.updatedAt ?? row.updated_at ?? row.createdAt ?? row.created_at);
      const stableId = id || `${key}:${agent || "none"}`;
      if (!uniq.has(stableId)) {
        uniq.set(stableId, {
          id: stableId,
          key,
          state,
          agent,
          updatedAt,
        });
      }
    }
    return [...uniq.values()];
  }

  private buildAgents(agentsPayload: unknown, nodesPayload: unknown, sessions: BridgeSession[], logs: string[]): BridgeAgent[] {
    const rows = [
      ...extractArrayShallow(agentsPayload, ["items", "agents", "list"]).map((entry) => asObject(entry)),
      ...extractArrayShallow(nodesPayload, ["items", "nodes", "list"]).map((entry) => asObject(entry)),
    ];
    const map = new Map<string, BridgeAgent>();
    for (const row of rows) {
      const id = typeof row.id === "string" ? row.id : typeof row.agentId === "string" ? row.agentId : typeof row.nodeId === "string" ? row.nodeId : "";
      const name = typeof row.name === "string" ? row.name : typeof row.label === "string" ? row.label : id || "agent";
      const workspace =
        typeof row.workspace === "string"
          ? row.workspace
          : typeof row.workspacePath === "string"
            ? row.workspacePath
            : undefined;
      const key = id || name;
      if (!key) continue;
      if (!map.has(key)) {
        map.set(key, {
          id: key,
          name,
          workspace,
          state: "ready",
          info: workspace ? `Workspace: ${workspace}` : "Connected via OpenClaw CLI",
          logs: [],
        });
      }
    }
    const sessionIndex = new Map<string, number>();
    for (const session of sessions) {
      const keys = [session.agent?.toLowerCase(), session.id.toLowerCase(), session.key.toLowerCase()].filter(Boolean) as string[];
      for (const [agentKey, agent] of map.entries()) {
        const idNeedle = agent.id.toLowerCase();
        const nameNeedle = agent.name.toLowerCase();
        if (keys.some((value) => value.includes(idNeedle) || value.includes(nameNeedle))) {
          sessionIndex.set(agentKey, (sessionIndex.get(agentKey) ?? 0) + 1);
        }
      }
    }
    for (const [agentKey, agent] of map.entries()) {
      const idNeedle = agent.id.toLowerCase();
      const nameNeedle = agent.name.toLowerCase();
      const agentLogs = logs.filter((line) => {
        const low = line.toLowerCase();
        return low.includes(idNeedle) || low.includes(nameNeedle);
      });
      const effectiveLogs = agentLogs.length > 0 ? agentLogs : logs;
      const hasError = effectiveLogs.some((line) => /\berror\b|\bfailed\b|\bunreachable\b/i.test(line));
      const isRunning = (sessionIndex.get(agentKey) ?? 0) > 0;
      map.set(agentKey, {
        ...agent,
        state: hasError ? "down" : isRunning ? "running" : "ready",
        info: hasError ? "Issues detected in runtime logs" : isRunning ? "Active sessions running" : "Idle and ready",
        logs: effectiveLogs.slice(-160),
      });
    }
    return [...map.values()];
  }

  private async loadLogs(statusPayload: unknown) {
    try {
      const logPath = extractFirstLogPath(statusPayload);
      if (!logPath) {
        return { source: "none", lines: [] as string[] };
      }
      const raw = await readFile(logPath, "utf8");
      const lines = raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(-4000);
      return { source: logPath, lines };
    } catch {
      return { source: "none", lines: [] as string[] };
    }
  }

  async sync(force = false) {
    if (this.syncPromise && !force) return this.syncPromise;
    this.syncPromise = (async () => {
      this.setPartial({ syncing: true, sourceStatus: "syncing", warnings: [] });

      const [statusResult, agentsResult, nodesResult, sessionsResult] = await Promise.all([
        firstSuccessfulCli([["status", "--json"], ["doctor", "--json"]], 12000),
        firstSuccessfulCli([["agents", "list", "--json"], ["agent", "list", "--json"]], 12000),
        firstSuccessfulCli([["nodes", "status", "--json"], ["nodes", "list", "--json"]], 12000),
        firstSuccessfulCli(
          [
            ["sessions", "--all-agents", "--json"],
            ["sessions", "--json"],
            ["sessions", "list", "--json"],
            ["session", "list", "--json"],
          ],
          15000
        ),
      ]);

      const warnings: string[] = [];
      if (!statusResult.ok && statusResult.error) warnings.push(statusResult.error);
      if (!agentsResult.ok && agentsResult.error) warnings.push(agentsResult.error);
      if (!nodesResult.ok && nodesResult.error) warnings.push(nodesResult.error);
      if (!sessionsResult.ok && sessionsResult.error) warnings.push(sessionsResult.error);

      const statusPayload = statusResult.payload ?? {};
      const sessions = this.buildSessions(sessionsResult.payload ?? {});
      const logs = await this.loadLogs(statusPayload);
      const agents = this.buildAgents(agentsResult.payload ?? {}, nodesResult.payload ?? {}, sessions, logs.lines);

      this.setPartial({
        syncing: false,
        connected: statusResult.ok || agents.length > 0,
        sourceStatus: statusResult.ok ? "ok" : "warning",
        warnings,
        lastSyncAt: new Date().toISOString(),
        agents,
        sessions,
        logs,
      });

      return this.state;
    })();

    try {
      return await this.syncPromise;
    } finally {
      this.syncPromise = null;
    }
  }

  async ensureReady() {
    if (this.state.lastSyncAt) return this.state;
    return await this.sync();
  }

  getSessions(agentId?: string) {
    if (!agentId?.trim()) return this.state.sessions;
    const needle = agentId.trim().toLowerCase();
    return this.state.sessions.filter((session) => {
      const values = [session.agent, session.key, session.id]
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.toLowerCase());
      return values.some((value) => value.includes(needle));
    });
  }

  getLogs(agentId?: string, range: "all" | "12h" = "all", limit = 500) {
    const needle = agentId?.trim().toLowerCase();
    const base = needle
      ? this.state.logs.lines.filter((line) => line.toLowerCase().includes(needle))
      : this.state.logs.lines;
    const lines = range === "12h"
      ? base.filter((line) => {
          const ts = parseLogTimestamp(line);
          if (!ts) return false;
          return Date.now() - ts <= 12 * 60 * 60 * 1000;
        })
      : base;
    const selected = (lines.length > 0 ? lines : base).slice(-Math.max(50, Math.min(3000, limit)));
    return {
      source: this.state.logs.source,
      lines: selected,
    };
  }

  private registerRun(kind: BridgeRun["kind"], agentId: string, title: string, input?: unknown) {
    const now = new Date().toISOString();
    const run: BridgeRun = {
      id: randomUUID(),
      kind,
      agentId,
      title,
      status: "queued",
      createdAt: now,
      updatedAt: now,
      input,
    };
    this.state = {
      ...this.state,
      runs: [run, ...this.state.runs].slice(0, 200),
    };
    this.publish();
    return run.id;
  }

  private updateRun(runId: string, patch: Partial<BridgeRun>) {
    this.state = {
      ...this.state,
      runs: this.state.runs.map((run) => (run.id === runId ? { ...run, ...patch, updatedAt: new Date().toISOString() } : run)),
    };
    this.publish();
  }

  async sendChat(agentId: string, message: string) {
    const runId = this.registerRun("chat", agentId, `Chat: ${message.slice(0, 60)}`, { message });
    this.updateRun(runId, { status: "running" });
    const cliFirst = await firstSuccessfulCli([
      ["agent", "--agent", agentId, "--message", message, "--json"],
      ["agent", "--agent", agentId, "--message", message],
    ], 60000);
    if (!cliFirst.ok) {
      this.updateRun(runId, { status: "failed", error: cliFirst.error });
      throw new Error(`Chat failed: ${cliFirst.error}`);
    }
    const text = extractChatText(cliFirst.payload);
    const meta = asObject(asObject(asObject(cliFirst.payload).result).meta);
    const agentMeta = asObject(meta.agentMeta);
    const sessionId = typeof agentMeta.sessionId === "string" ? agentMeta.sessionId : undefined;
    this.updateRun(runId, {
      status: "completed",
      output: {
        text,
        raw: cliFirst.payload,
        source: cliFirst.source,
      },
    });
    if (sessionId) {
      const exists = this.state.sessions.some((session) => session.id === sessionId);
      if (!exists) {
        this.state = {
          ...this.state,
          sessions: [
            {
              id: sessionId,
              key: `agent:${agentId}:main`,
              state: "active",
              agent: agentId,
              updatedAt: new Date().toISOString(),
            },
            ...this.state.sessions,
          ],
        };
        this.publish();
      }
    }
    // append runtime line
    this.state = {
      ...this.state,
      logs: {
        ...this.state.logs,
        lines: [...this.state.logs.lines, `${new Date().toISOString()} INFO chat(${agentId}) ${text}`].slice(-4000),
      },
    };
    this.publish();
    return {
      runId,
      source: cliFirst.source,
      payload: cliFirst.payload,
      text,
    };
  }

  async createAgent(agent: { id: string; name: string; workspace?: string }) {
    const id = agent.id.trim();
    const name = agent.name.trim();
    const workspace = agent.workspace?.trim();
    if (!id || !name) throw new Error("Agent id and name are required.");

    const argsBase = [id, ...(workspace ? ["--workspace", workspace] : []), "--json"];
    const result = await firstSuccessfulCli(
      [
        ["agents", "add", ...argsBase],
        ["agents", "add", id, ...(workspace ? ["--workspace", workspace] : [])],
      ],
      30000
    );
    if (!result.ok) {
      throw new Error(result.error || "Agent creation failed.");
    }
    await this.sync(true);
    return { source: result.source, payload: result.payload };
  }

  async delegate(kind: "task" | "issue" | "project", agentId: string, input: Record<string, unknown>) {
    const title = String(input.title ?? input.name ?? kind);
    const runId = this.registerRun(kind, agentId, `${kind.toUpperCase()}: ${title}`, input);
    this.updateRun(runId, { status: "running" });
    const prompt = [
      `You have a new ${kind} assignment from AgenticOS.`,
      `Title: ${title}`,
      `Description: ${String(input.description ?? "").trim() || "(none provided)"}`,
      `Project: ${String(input.project ?? "").trim() || "(none)"}`,
      `Priority: ${String(input.priority ?? "Medium")}`,
      `Status: ${String(input.status ?? "Todo")}`,
      "",
      "Please acknowledge, provide a short execution plan, and start working on it now.",
    ].join("\n");

    const result = await firstSuccessfulCli(
      [
        ["agent", "--agent", agentId, "--message", prompt, "--json"],
        ["agent", "--agent", agentId, "--message", prompt],
      ],
      60000
    );
    if (!result.ok) {
      this.updateRun(runId, { status: "failed", error: result.error });
      throw new Error(`Delegation failed: ${result.error}`);
    }
    this.updateRun(runId, {
      status: "completed",
      output: { source: result.source, payload: result.payload, text: extractChatText(result.payload) },
    });
    return { runId, source: result.source, payload: result.payload };
  }
}

declare global {
  var __openclawBridge__: OpenclawBridge | undefined;
}

export const openclawBridge = global.__openclawBridge__ ?? new OpenclawBridge();
if (!global.__openclawBridge__) {
  global.__openclawBridge__ = openclawBridge;
}
