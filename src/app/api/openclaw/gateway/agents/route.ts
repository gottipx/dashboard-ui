import { NextResponse } from "next/server";

import { openclawRpc } from "@/lib/openclaw/gateway-rpc";

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
    const cfgPayload = await openclawRpc({ url: body.url, auth, method: "config.get", params: {} });
    const cfg = parseAgents(cfgPayload);

    if (body.action === "list" || !body.action) {
      return NextResponse.json({ ok: true, agents: cfg.list });
    }

    if (body.action === "create") {
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

      const patchResult = await openclawRpc({
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
