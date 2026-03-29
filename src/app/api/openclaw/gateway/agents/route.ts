import { NextResponse } from "next/server";

import { callGateway } from "@/lib/openclaw/gateway-call";
import { runOpenclawCliJson } from "@/lib/openclaw/cli";

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

function parseAgents(configPayload: unknown) {
  const payload = (configPayload ?? {}) as Record<string, unknown>;
  const config = (payload.config ?? payload.value ?? payload) as Record<string, unknown>;
  const agents = (config.agents ?? {}) as Record<string, unknown>;
  const list = Array.isArray(agents.list) ? agents.list : [];
  return {
    list,
    hash: typeof payload.hash === "string" ? payload.hash : undefined,
  };
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Body;
    if (!body.url) {
      return NextResponse.json({ error: "Missing gateway url." }, { status: 400 });
    }

    const auth = { token: body.token, password: body.password };

    if (body.action === "list" || !body.action) {
      try {
        const cfgPayload = await callGateway({ url: body.url, auth, method: "config.get", params: {}, timeoutMs: 10000 });
        const cfg = parseAgents(cfgPayload);
        if (cfg.list.length > 0) {
          return NextResponse.json({ ok: true, agents: cfg.list, source: "config.get" });
        }
      } catch {
        // continue with fallbacks below
      }

      try {
        // fallback for deployments that block config methods or return empty agents list
        const nodesPayload = await callGateway({ url: body.url, auth, method: "node.list", params: {}, timeoutMs: 10000 });
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
            agents,
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
            agents,
            source: "nodes.status",
            warning: "config.get/node.list had no agents; using nodes status.",
          });
        }
      } catch {
        // continue with presence fallback below
      }

      // final fallback using presence
      const presencePayload = await callGateway({
        url: body.url,
        auth,
        method: "system-presence",
        params: {},
        timeoutMs: 10000,
      });
      const payload = (presencePayload ?? {}) as Record<string, unknown>;
      const items = Array.isArray(payload.items) ? payload.items : [];
      const agents = items
        .map((entry, idx) => {
          const row = entry as Record<string, unknown>;
          const roles = Array.isArray(row.roles) ? row.roles.map(String) : [];
          if (roles.length > 0 && !roles.includes("node")) return null;
          return {
            id: typeof row.deviceId === "string" ? row.deviceId : `presence-${idx + 1}`,
            name:
              typeof row.name === "string"
                ? row.name
                : typeof row.label === "string"
                  ? row.label
                  : typeof row.deviceId === "string"
                    ? row.deviceId
                    : "Gateway Presence",
            workspace: undefined,
          };
        })
        .filter(Boolean);
      return NextResponse.json({
        ok: true,
        agents,
        source: "system-presence",
        warning: "config.get/node.list/nodes.status had no agents; showing presence entries.",
      });
    }

    if (body.action === "create") {
      const cfgPayload = await callGateway({ url: body.url, auth, method: "config.get", params: {}, timeoutMs: 10000 });
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
      const patchPayload: Record<string, unknown> = {
        raw: JSON.stringify({ agents: { list: nextList } }),
      };
      if (cfg.hash) patchPayload.baseHash = cfg.hash;

      const patchResult = await callGateway({
        url: body.url,
        auth,
        method: "config.patch",
        params: patchPayload,
      });

      return NextResponse.json({ ok: true, agent: nextAgent, patch: patchResult });
    }

    return NextResponse.json({ error: "Unsupported action." }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Gateway agents API failed";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
