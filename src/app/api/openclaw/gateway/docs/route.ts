import { NextResponse } from "next/server";

import { callGateway } from "@/lib/openclaw/gateway-call";
import { resolveGatewayRuntime } from "@/lib/openclaw/runtime-config";

export const runtime = "nodejs";

type Body = {
  url?: string;
  token?: string;
  password?: string;
  action?: "read" | "write";
  agentId?: string;
  path?: string;
  content?: string;
  readMethod?: string;
  writeMethod?: string;
};

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Body;
    if (!body.path || !body.action) {
      return NextResponse.json({ error: "Missing path or action." }, { status: 400 });
    }
    const runtime = resolveGatewayRuntime(body);

    const auth = runtime.auth;
    const readMethod = body.readMethod || "workspace.read";
    const writeMethod = body.writeMethod || "workspace.write";

    if (body.action === "read") {
      const payload = await callGateway({
        url: runtime.url,
        auth,
        method: readMethod,
        params: {
          path: body.path,
          agentId: body.agentId,
          agent: body.agentId,
          nodeId: body.agentId,
        },
      });
      return NextResponse.json({ ok: true, payload });
    }

    const payload = await callGateway({
      url: runtime.url,
      auth,
      method: writeMethod,
      params: {
        path: body.path,
        content: body.content ?? "",
        agentId: body.agentId,
        agent: body.agentId,
        nodeId: body.agentId,
      },
    });
    return NextResponse.json({ ok: true, payload });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Gateway docs API failed";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
