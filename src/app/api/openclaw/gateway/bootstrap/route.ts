import { NextResponse } from "next/server";

import { openclawRpc } from "@/lib/openclaw/gateway-rpc";

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
      openclawRpc({ url: body.url, auth, method: "status", params: {} }),
      openclawRpc({ url: body.url, auth, method: "health", params: {} }),
      openclawRpc({ url: body.url, auth, method: "system-presence", params: {} }),
      openclawRpc({ url: body.url, auth, method: "node.list", params: {} }),
      openclawRpc({ url: body.url, auth, method: "sessions.list", params: {} }),
    ]);

    const unwrap = (result: PromiseSettledResult<unknown>) =>
      result.status === "fulfilled" ? result.value : { error: result.reason instanceof Error ? result.reason.message : String(result.reason) };

    return NextResponse.json({
      ok: true,
      data: {
        status: unwrap(status),
        health: unwrap(health),
        presence: unwrap(presence),
        nodes: unwrap(nodes),
        sessions: unwrap(sessions),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Gateway bootstrap failed";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
