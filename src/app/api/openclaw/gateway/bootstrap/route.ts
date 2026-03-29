import { NextResponse } from "next/server";

import { callGateway } from "@/lib/openclaw/gateway-call";
import { runOpenclawCliJson } from "@/lib/openclaw/cli";

export const runtime = "nodejs";

type BootstrapBody = {
  url?: string;
  token?: string;
  password?: string;
};

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as BootstrapBody;
    if (!body.url) {
      return NextResponse.json({ error: "Missing gateway url." }, { status: 400 });
    }

    const auth = { token: body.token, password: body.password };

    const [status, health, presence, nodes, sessions] = await Promise.allSettled([
      callGateway({ url: body.url, auth, method: "status", params: {} }),
      callGateway({ url: body.url, auth, method: "health", params: {} }),
      callGateway({ url: body.url, auth, method: "system-presence", params: {} }),
      callGateway({ url: body.url, auth, method: "node.list", params: {} }),
      callGateway({ url: body.url, auth, method: "sessions.list", params: {} }),
    ]);

    const unwrap = (result: PromiseSettledResult<unknown>) =>
      result.status === "fulfilled" ? result.value : { error: result.reason instanceof Error ? result.reason.message : String(result.reason) };

    let nodesValue = unwrap(nodes);
    const nodesObj = nodesValue as Record<string, unknown>;
    const nodesHasError = typeof nodesObj?.error === "string";
    if (nodesHasError) {
      try {
        const cliNodes = await runOpenclawCliJson(["nodes", "status", "--json"], 12000);
        nodesValue = cliNodes;
      } catch {
        // keep gateway error payload
      }
    }

    return NextResponse.json({
      ok: true,
      data: {
        status: unwrap(status),
        health: unwrap(health),
        presence: unwrap(presence),
        nodes: nodesValue,
        sessions: unwrap(sessions),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Gateway bootstrap failed";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
