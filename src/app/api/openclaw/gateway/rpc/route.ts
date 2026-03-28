import { NextResponse } from "next/server";

import { openclawRpc } from "@/lib/openclaw/gateway-rpc";

export const runtime = "nodejs";

type RpcBody = {
  url?: string;
  token?: string;
  password?: string;
  method?: string;
  params?: Record<string, unknown>;
  expectFinal?: boolean;
};

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as RpcBody;
    if (!body.url || !body.method) {
      return NextResponse.json({ error: "Missing url or method." }, { status: 400 });
    }

    const payload = await openclawRpc({
      url: body.url,
      auth: { token: body.token, password: body.password },
      method: body.method,
      params: body.params ?? {},
      expectFinal: Boolean(body.expectFinal),
      timeoutMs: 20000,
    });

    return NextResponse.json({ ok: true, payload });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Gateway RPC failed";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
