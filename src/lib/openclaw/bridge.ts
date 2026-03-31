import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFile, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

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

export type BridgeChatMessage = {
  id: string;
  role: "user" | "agent";
  text: string;
  at: string;
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
      const row = asObject(current);
      if (Object.keys(row).length > 0 && predicate(row)) {
        found.push(row);
      }
      for (const value of Object.values(row)) queue.push(value);
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

function extractModelsFromPayload(payload: unknown): string[] {
  const queue: unknown[] = [payload];
  const out: string[] = [];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    if (typeof current === "string") {
      const matches = current.match(/[a-z0-9._-]+\/[a-z0-9._-]+/gi) ?? [];
      for (const match of matches) {
        if (!seen.has(match)) {
          seen.add(match);
          out.push(match);
        }
      }
      continue;
    }
    if (Array.isArray(current)) {
      for (const item of current) queue.push(item);
      continue;
    }
    if (typeof current === "object") {
      const row = asObject(current);
      const candidates = [row.model, row.id, row.ref, row.name, row.alias]
        .filter((entry) => typeof entry === "string")
        .map((entry) => String(entry).trim())
        .filter((entry) => entry.includes("/"));
      for (const model of candidates) {
        if (!seen.has(model)) {
          seen.add(model);
          out.push(model);
        }
      }
      for (const value of Object.values(row)) queue.push(value);
    }
  }
  return out;
}

function extractResolvedModel(payload: unknown): string {
  const queue: unknown[] = [payload];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    if (typeof current === "string") {
      const match = current.match(/[a-z0-9._-]+\/[a-z0-9._-]+/i);
      if (match) return match[0];
      continue;
    }
    if (Array.isArray(current)) {
      for (const item of current) queue.push(item);
      continue;
    }
    if (typeof current === "object") {
      const row = asObject(current);
      const direct =
        typeof row.primary === "string"
          ? row.primary
          : typeof row.model === "string"
            ? row.model
            : typeof row.default === "string"
              ? row.default
              : "";
      if (direct.includes("/")) return direct;
      for (const value of Object.values(row)) queue.push(value);
    }
  }
  return "";
}

function parseChatTimestamp(row: Record<string, unknown>) {
  const meta = asObject(row.meta);
  const result = asObject(row.result);
  const candidates = [
    row.timestamp,
    row.createdAt,
    row.updatedAt,
    row.at,
    row.time,
    row.ts,
    row.date,
    meta.timestamp,
    meta.createdAt,
    result.timestamp,
    result.createdAt,
    result.updatedAt,
  ]
    .filter((value) => typeof value === "string")
    .map((value) => String(value));
  for (const candidate of candidates) {
    const d = new Date(candidate);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return new Date().toISOString();
}

function parseChatRole(row: Record<string, unknown>): "user" | "agent" {
  const result = asObject(row.result);
  const output = asObject(row.output);
  const response = asObject(row.response);
  const payload = asObject(row.payload);
  const params = asObject(row.params);
  const input = asObject(row.input);
  const request = asObject(row.request);
  const roleRaw = String(
    row.role ??
      row.sender ??
      row.type ??
      row.kind ??
      row.event ??
      row.name ??
      row.action ??
      row.channel ??
      row.source ??
      row.direction ??
      result.role ??
      result.type ??
      ""
  ).toLowerCase();
  if (
    roleRaw.includes("assistant") ||
    roleRaw.includes("agent") ||
    roleRaw.includes("system") ||
    roleRaw.includes("model") ||
    roleRaw.includes("response") ||
    roleRaw.includes("output") ||
    roleRaw.includes("completion")
  ) {
    return "agent";
  }
  if (roleRaw.includes("user") || roleRaw.includes("human") || roleRaw.includes("input") || roleRaw.includes("prompt")) {
    return "user";
  }

  if (
    Array.isArray(row.payloads) ||
    Array.isArray(result.payloads) ||
    Array.isArray(output.payloads) ||
    Array.isArray(response.payloads) ||
    Array.isArray(payload.payloads) ||
    typeof asObject(row.delta).text === "string" ||
    typeof asObject(row.delta).content === "string" ||
    typeof asObject(result.delta).text === "string" ||
    typeof asObject(result.delta).content === "string"
  ) {
    return "agent";
  }
  if (
    typeof params.message === "string" ||
    typeof params.text === "string" ||
    typeof params.prompt === "string" ||
    typeof input.message === "string" ||
    typeof input.text === "string" ||
    typeof input.prompt === "string" ||
    typeof request.message === "string" ||
    typeof request.text === "string" ||
    typeof request.prompt === "string" ||
    typeof row.prompt === "string"
  ) {
    return "user";
  }
  return "user";
}

function extractTextFromPayloadRows(rows: unknown): string {
  const items = Array.isArray(rows) ? rows : [];
  const chunks = items
    .map((entry) => asObject(entry))
    .map((entry) => {
      if (typeof entry.text === "string" && entry.text.trim()) return entry.text;
      if (typeof entry.content === "string" && entry.content.trim()) return entry.content;
      if (typeof entry.message === "string" && entry.message.trim()) return entry.message;
      return "";
    })
    .filter((entry) => entry.trim().length > 0);
  return chunks.join("\n").trim();
}

function extractChatTextStrict(payload: unknown): string {
  const root = asObject(payload);
  const direct = typeof root.text === "string" ? root.text : typeof root.content === "string" ? root.content : "";
  if (direct.trim()) return direct.trim();
  const result = asObject(root.result ?? root.payload ?? root.data ?? root.output ?? root.response ?? root);
  const payloadText = extractTextFromPayloadRows(result.payloads);
  if (payloadText) return payloadText;
  if (typeof result.message === "string" && result.message.trim()) return result.message.trim();
  return "";
}

function parseChatText(row: Record<string, unknown>): string {
  const result = asObject(row.result);
  const output = asObject(row.output);
  const response = asObject(row.response);
  const payload = asObject(row.payload);
  const data = asObject(row.data);
  const params = asObject(row.params);
  const input = asObject(row.input);
  const request = asObject(row.request);

  const direct =
    typeof row.text === "string"
      ? row.text
      : typeof row.message === "string"
        ? row.message
        : typeof row.content === "string"
          ? row.content
          : typeof row.prompt === "string"
            ? row.prompt
            : "";
  if (direct.trim()) return direct;

  const payloadText = [
    extractTextFromPayloadRows(row.payloads),
    extractTextFromPayloadRows(result.payloads),
    extractTextFromPayloadRows(output.payloads),
    extractTextFromPayloadRows(response.payloads),
    extractTextFromPayloadRows(payload.payloads),
    extractTextFromPayloadRows(data.payloads),
  ].find((entry) => entry.length > 0);
  if (payloadText) return payloadText;

  const deltaCandidates = [row.delta, result.delta, output.delta, response.delta, payload.delta, data.delta];
  for (const deltaValue of deltaCandidates) {
    const delta = asObject(deltaValue);
    if (typeof delta.text === "string" && delta.text.trim()) return delta.text;
    if (typeof delta.content === "string" && delta.content.trim()) return delta.content;
  }

  const nestedCandidates = [
    result.text,
    result.content,
    result.message,
    output.text,
    output.content,
    output.message,
    response.text,
    response.content,
    response.message,
    payload.text,
    payload.content,
    payload.message,
    data.text,
    data.content,
    data.message,
    input.message,
    input.text,
    input.prompt,
    params.message,
    params.text,
    params.prompt,
    request.message,
    request.text,
    request.prompt,
  ];
  for (const candidate of nestedCandidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate;
  }

  const strictResult = [extractChatTextStrict(result), extractChatTextStrict(output), extractChatTextStrict(response)].find(
    (entry) => entry.length > 0
  );
  if (strictResult) return strictResult;

  return "";
}

function parseTranscriptContent(content: string): BridgeChatMessage[] {
  const parsedRows: Record<string, unknown>[] = [];

  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    if (!line.startsWith("{") && !line.startsWith("[")) continue;
    try {
      const row = JSON.parse(line);
      if (Array.isArray(row)) {
        for (const entry of row) {
          const obj = asObject(entry);
          if (Object.keys(obj).length > 0) parsedRows.push(obj);
        }
      } else {
        const obj = asObject(row);
        if (Object.keys(obj).length > 0) parsedRows.push(obj);
      }
    } catch {
      // ignore malformed lines
    }
  }

  if (parsedRows.length === 0) {
    try {
      const root = JSON.parse(content);
      if (Array.isArray(root)) {
        for (const entry of root) {
          const obj = asObject(entry);
          if (Object.keys(obj).length > 0) parsedRows.push(obj);
        }
      } else {
        const obj = asObject(root);
        const collections = [obj.messages, obj.history, obj.events].filter((value) => Array.isArray(value)) as unknown[][];
        if (collections.length > 0) {
          for (const collection of collections) {
            for (const entry of collection) {
              const row = asObject(entry);
              if (Object.keys(row).length > 0) parsedRows.push(row);
            }
          }
        } else if (Object.keys(obj).length > 0) {
          parsedRows.push(obj);
        }
      }
    } catch {
      // ignore non-json transcript
    }
  }

  const messages: BridgeChatMessage[] = [];
  for (const row of parsedRows) {
    const text = parseChatText(row);
    if (!text.trim()) continue;
    messages.push({
      id: randomUUID(),
      role: parseChatRole(row),
      text,
      at: parseChatTimestamp(row),
    });
  }
  return messages;
}

function extractChatMessagesFromPayload(payload: unknown): BridgeChatMessage[] {
  const arrayRows = extractArrayShallow(payload, ["messages", "history", "events", "entries", "items", "payloads"]).map((entry) =>
    asObject(entry)
  );
  const deepRows = deepCollectArrays(payload, (row) =>
    ["role", "sender", "type", "kind", "event", "text", "message", "content", "delta", "payloads", "result", "input", "params"].some(
      (key) => key in row
    )
  );
  const rows = [...arrayRows, ...deepRows];
  const dedupe = new Set<string>();
  const messages: BridgeChatMessage[] = [];
  for (const row of rows) {
    const text = parseChatText(row);
    if (!text.trim()) continue;
    const role = parseChatRole(row);
    const at = parseChatTimestamp(row);
    const signature = `${role}|${at}|${text.trim()}`;
    if (dedupe.has(signature)) continue;
    dedupe.add(signature);
    messages.push({
      id: randomUUID(),
      role,
      text,
      at,
    });
  }
  return messages;
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
    const roots = [payload, asObject(payload).payload, asObject(payload).data].map((entry) => asObject(entry));
    const objectMapItems = roots
      .flatMap((root) => {
        const maps = [root, asObject(root.sessions), asObject(root.items), asObject(root.entries)];
        return maps.flatMap((map) =>
          Object.entries(map).flatMap(([mapKey, mapValue]) => {
            const row = asObject(mapValue);
            if (Object.keys(row).length === 0) return [];
            const maybeSession = [
              row.id,
              row.sessionId,
              row.session_id,
              row.sessionKey,
              row.state,
              row.status,
              row.agent,
              row.agentId,
              row.nodeId,
              row.updatedAt,
              row.createdAt,
            ].some((value) => typeof value === "string" || typeof value === "number");
            if (!maybeSession) return [];
            return [{ ...row, key: typeof row.key === "string" && row.key.trim() ? row.key : mapKey }];
          })
        );
      })
      .map((entry) => asObject(entry));
    const deepItems = deepCollectArrays(payload, (row) =>
      ["id", "sessionId", "session_id", "sessionKey", "key", "state", "status", "agent", "agentId", "nodeId"].some((k) => k in row)
    );
    const all = [...baseItems.map((entry) => asObject(entry)), ...objectMapItems, ...deepItems];
    const uniq = new Map<string, BridgeSession>();
    for (const row of all) {
      const id =
        typeof row.id === "string"
          ? row.id
          : typeof row.sessionId === "string"
            ? row.sessionId
            : typeof row.session_id === "string"
              ? row.session_id
              : "";
      const key =
        typeof row.key === "string"
          ? row.key
          : typeof row.sessionKey === "string"
            ? row.sessionKey
            : typeof row.name === "string"
              ? row.name
              : id || "session";
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
      const stableId = id || key || `${agent || "agent"}:${updatedAt || "session"}`;
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
      const isRunning =
        (sessionIndex.get(agentKey) ?? 0) > 0 &&
        effectiveLogs.some((line) => /\bbusy\b|\bprocessing\b|\bexecuting\b|\bin progress\b|\bworking\b/i.test(line));
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

  getLogs(agentId?: string, range: "all" | "2h" = "2h", limit = 500) {
    const needle = agentId?.trim().toLowerCase();
    const base = needle
      ? this.state.logs.lines.filter((line) => line.toLowerCase().includes(needle))
      : this.state.logs.lines;
    const lines = range === "2h"
      ? base.filter((line) => {
          const ts = parseLogTimestamp(line);
          if (!ts) return false;
          return Date.now() - ts <= 2 * 60 * 60 * 1000;
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

  async sendChat(agentId: string, message: string, sessionId?: string) {
    const runId = this.registerRun("chat", agentId, `Chat: ${message.slice(0, 60)}`, { message, sessionId });
    this.updateRun(runId, { status: "running" });
    const attempts: string[][] = sessionId
      ? [
          ["agent", "--agent", agentId, "--session-id", sessionId, "--message", message, "--json"],
          ["agent", "--agent", agentId, "--session-id", sessionId, "--message", message],
          ["agent", "--session-id", sessionId, "--message", message, "--json"],
          ["agent", "--session-id", sessionId, "--message", message],
          ["agent", "--agent", agentId, "--message", message, "--json"],
          ["agent", "--agent", agentId, "--message", message],
        ]
      : [
          ["agent", "--agent", agentId, "--message", message, "--json"],
          ["agent", "--agent", agentId, "--message", message],
        ];

    const cliFirst = await firstSuccessfulCli(attempts, 60000);
    if (!cliFirst.ok) {
      this.updateRun(runId, { status: "failed", error: cliFirst.error });
      throw new Error(`Chat failed: ${cliFirst.error}`);
    }
    const text = extractChatText(cliFirst.payload);
    const meta = asObject(asObject(asObject(cliFirst.payload).result).meta);
    const agentMeta = asObject(meta.agentMeta);
    const runtimeSessionId = typeof agentMeta.sessionId === "string" ? agentMeta.sessionId : sessionId;
    this.updateRun(runId, {
      status: "completed",
      output: {
        text,
        raw: cliFirst.payload,
        source: cliFirst.source,
      },
    });
    if (runtimeSessionId) {
      const exists = this.state.sessions.some((session) => session.id === runtimeSessionId);
      if (!exists) {
        this.state = {
          ...this.state,
          sessions: [
            {
              id: runtimeSessionId,
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
      sessionId: runtimeSessionId,
    };
  }

  async getSessionHistory(agentId: string, sessionId: string, limit = 200, sessionKey?: string): Promise<BridgeChatMessage[]> {
    const normalizedSessionId = sessionId.trim();
    const normalizedSessionKey = sessionKey?.trim() || "";
    const maxLimit = Math.max(20, Math.min(50000, limit));
    const historyAttempts: string[][] = [];
    if (normalizedSessionId) {
      historyAttempts.push(
        ["sessions", "history", "--session-id", normalizedSessionId, "--limit", String(maxLimit), "--json"],
        ["sessions", "history", "--session-id", normalizedSessionId, "--json"],
        ["sessions", "history", "--session", normalizedSessionId, "--json"],
        ["sessions", "history", "--id", normalizedSessionId, "--json"],
        ["sessions", "history", normalizedSessionId, "--json"],
        ["session", "history", "--session-id", normalizedSessionId, "--limit", String(maxLimit), "--json"],
        ["session", "history", "--session-id", normalizedSessionId, "--json"],
        ["session", "history", normalizedSessionId, "--json"]
      );
    }
    if (normalizedSessionKey) {
      historyAttempts.push(
        ["sessions", "history", "--session-key", normalizedSessionKey, "--limit", String(maxLimit), "--json"],
        ["sessions", "history", "--session-key", normalizedSessionKey, "--json"],
        ["sessions", "history", "--key", normalizedSessionKey, "--json"],
        ["sessions", "history", normalizedSessionKey, "--json"],
        ["session", "history", "--session-key", normalizedSessionKey, "--limit", String(maxLimit), "--json"],
        ["session", "history", "--session-key", normalizedSessionKey, "--json"]
      );
    }
    if (historyAttempts.length > 0) {
      const cliHistory = await firstSuccessfulCli(historyAttempts, 45000);
      if (cliHistory.ok) {
        const cliMessages = extractChatMessagesFromPayload(cliHistory.payload);
        if (cliMessages.length > 0) {
          cliMessages.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
          return cliMessages.slice(-maxLimit);
        }
      }
    }

    const roots = [
      process.env.OPENCLAW_HOME,
      "/home/openclaw/.openclaw",
      "/root/.openclaw",
    ].filter(Boolean) as string[];
    const needles = [normalizedSessionId, normalizedSessionKey]
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0);

    const normalizeCandidatePath = (value: unknown, sessionsDir: string) => {
      if (typeof value !== "string") return "";
      const trimmed = value.trim();
      if (!trimmed) return "";
      return path.isAbsolute(trimmed) ? trimmed : path.join(sessionsDir, trimmed);
    };

    for (const root of roots) {
      const sessionsDir = path.join(root, "agents", agentId, "sessions");
      const candidates = new Set<string>();
      const inlineMessages: BridgeChatMessage[] = [];

      if (normalizedSessionId) {
        candidates.add(path.join(sessionsDir, `${normalizedSessionId}.jsonl`));
        candidates.add(path.join(sessionsDir, `${normalizedSessionId}.json`));
      }
      if (normalizedSessionKey) {
        candidates.add(path.join(sessionsDir, `${normalizedSessionKey}.jsonl`));
        candidates.add(path.join(sessionsDir, `${normalizedSessionKey}.json`));
      }

      try {
        const sessionsStorePath = path.join(sessionsDir, "sessions.json");
        const rawStore = await readFile(sessionsStorePath, "utf8");
        const parsedStore = asObject(JSON.parse(rawStore));
        for (const [entryKey, entryValue] of Object.entries(parsedStore)) {
          const row = asObject(entryValue);
          const rowSessionId =
            typeof row.sessionId === "string"
              ? row.sessionId
              : typeof row.id === "string"
                ? row.id
                : typeof row.session === "string"
                  ? row.session
                  : "";
          const rowCandidates = [
            entryKey,
            rowSessionId,
            typeof row.key === "string" ? row.key : "",
            typeof row.name === "string" ? row.name : "",
            typeof row.sessionKey === "string" ? row.sessionKey : "",
          ]
            .map((entry) => entry.trim().toLowerCase())
            .filter((entry) => entry.length > 0);
          const matches = needles.length === 0 || needles.some((needle) => rowCandidates.some((value) => value.includes(needle)));
          if (!matches) continue;

          const pathCandidates = [
            row.path,
            row.file,
            row.filePath,
            row.transcript,
            row.transcriptPath,
            row.historyPath,
            row.eventsPath,
            row.logPath,
            row.outputPath,
            row.messagesPath,
          ];
          for (const candidate of pathCandidates) {
            const normalized = normalizeCandidatePath(candidate, sessionsDir);
            if (normalized) candidates.add(normalized);
          }
          if (Array.isArray(row.files)) {
            for (const candidate of row.files) {
              const normalized = normalizeCandidatePath(candidate, sessionsDir);
              if (normalized) candidates.add(normalized);
            }
          }

          const inline = parseTranscriptContent(JSON.stringify(row));
          if (inline.length > 0) inlineMessages.push(...inline);
        }
      } catch {
        // sessions index not available
      }

      const fileFallbackCandidates: string[] = [];
      try {
        const files = await readdir(sessionsDir, { withFileTypes: true });
        for (const file of files) {
          if (!file.isFile()) continue;
          if (!file.name.endsWith(".jsonl") && !file.name.endsWith(".json")) continue;
          const lowerName = file.name.toLowerCase();
          const matchedByName = needles.length === 0 || needles.some((needle) => lowerName.includes(needle));
          const fullPath = path.join(sessionsDir, file.name);
          if (matchedByName) {
            candidates.add(fullPath);
          } else {
            fileFallbackCandidates.push(fullPath);
          }
        }
      } catch {
        // sessions directory not available in this root
      }

      if (candidates.size === 0 && fileFallbackCandidates.length > 0 && needles.length > 0) {
        for (const candidatePath of fileFallbackCandidates.slice(0, 120)) {
          try {
            const content = await readFile(candidatePath, "utf8");
            const lowered = content.toLowerCase();
            if (needles.some((needle) => lowered.includes(needle))) {
              candidates.add(candidatePath);
            }
          } catch {
            // ignore unreadable candidate
          }
        }
      }

      const aggregate: BridgeChatMessage[] = [];
      if (inlineMessages.length > 0) {
        aggregate.push(...inlineMessages);
      }
      for (const transcriptPath of candidates) {
        try {
          const content = await readFile(transcriptPath, "utf8");
          const messages = parseTranscriptContent(content);
          if (messages.length > 0) {
            aggregate.push(...messages);
          }
        } catch {
          // continue with other candidates
        }
      }

      if (aggregate.length > 0) {
        const dedupe = new Set<string>();
        const normalized: BridgeChatMessage[] = [];
        for (const message of aggregate) {
          const signature = `${message.role}|${message.at}|${message.text.trim()}`;
          if (dedupe.has(signature)) continue;
          dedupe.add(signature);
          normalized.push(message);
        }
        normalized.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
        return normalized.slice(-maxLimit);
      }
    }

    return [];
  }

  async deleteSession(agentId: string, sessionId: string, sessionKey?: string) {
    const roots = [process.env.OPENCLAW_HOME, "/home/openclaw/.openclaw", "/root/.openclaw"].filter(Boolean) as string[];
    let removed = 0;
    let removedTranscripts = 0;
    let storePath = "";
    for (const root of roots) {
      const sessionsDir = path.join(root, "agents", agentId, "sessions");
      const currentStorePath = path.join(sessionsDir, "sessions.json");
      try {
        const raw = await readFile(currentStorePath, "utf8");
        const parsed = asObject(JSON.parse(raw));
        const next: Record<string, unknown> = {};
        let changed = false;
        for (const [key, value] of Object.entries(parsed)) {
          const row = asObject(value);
          const rowSessionId = typeof row.sessionId === "string" ? row.sessionId : typeof row.id === "string" ? row.id : "";
          const shouldDelete = key === sessionKey || rowSessionId === sessionId;
          if (shouldDelete) {
            changed = true;
            removed += 1;
            continue;
          }
          next[key] = value;
        }
        if (changed) {
          await writeFile(currentStorePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
          storePath = currentStorePath;
        }
        const files = await readdir(sessionsDir, { withFileTypes: true });
        for (const file of files) {
          if (!file.isFile()) continue;
          if (!file.name.endsWith(".jsonl")) continue;
          if (!file.name.startsWith(sessionId)) continue;
          await unlink(path.join(sessionsDir, file.name));
          removedTranscripts += 1;
        }
      } catch {
        // try next root
      }
    }
    this.state = {
      ...this.state,
      sessions: this.state.sessions.filter((entry) => entry.id !== sessionId && entry.key !== sessionKey),
    };
    this.publish();
    return { removed, removedTranscripts, storePath };
  }

  async listModels() {
    const result = await firstSuccessfulCli(
      [
        ["models", "list", "--json"],
        ["models", "list", "--all", "--json"],
      ],
      20000
    );
    if (!result.ok) throw new Error(result.error || "Unable to list models.");
    return { models: extractModelsFromPayload(result.payload), source: result.source };
  }

  async getModelStatus(agentId?: string) {
    const args = ["models", "status", "--json", ...(agentId ? ["--agent", agentId] : [])];
    const result = await firstSuccessfulCli([args], 20000);
    if (!result.ok) throw new Error(result.error || "Unable to get model status.");
    return {
      model: extractResolvedModel(result.payload),
      source: result.source,
      payload: result.payload,
    };
  }

  async setAgentDefaultModel(agentId: string, model: string) {
    const listResult = await firstSuccessfulCli([["config", "get", "agents.list", "--json"]], 20000);
    if (!listResult.ok) throw new Error(listResult.error || "Unable to read agents list from config.");
    const rows = extractArrayShallow(listResult.payload, ["items", "agents", "list"]);
    const index = rows.findIndex((entry) => {
      const row = asObject(entry);
      const id = typeof row.id === "string" ? row.id : "";
      const name = typeof row.name === "string" ? row.name : "";
      return id.toLowerCase() === agentId.toLowerCase() || name.toLowerCase() === agentId.toLowerCase();
    });
    if (index < 0) throw new Error(`Agent ${agentId} not found in config agents.list.`);

    const setResult = await firstSuccessfulCli(
      [
        ["config", "set", `agents.list[${index}].model.primary`, model],
        ["config", "set", `agents.list[${index}].model`, model],
      ],
      20000
    );
    if (!setResult.ok) throw new Error(setResult.error || "Unable to set agent model.");
    return { source: setResult.source };
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
