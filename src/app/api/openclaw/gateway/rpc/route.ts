import { NextResponse } from "next/server";

import { callGateway } from "@/lib/openclaw/gateway-call";
import { resolveGatewayRuntime } from "@/lib/openclaw/runtime-config";

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
    if (!body.method) {
      return NextResponse.json({ error: "Missing method." }, { status: 400 });
    }
    const runtime = resolveGatewayRuntime(body);

    const payload = await callGateway({
      url: runtime.url,
      auth: runtime.auth,
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
