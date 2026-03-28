import { NextResponse } from "next/server";

import { openclawRpc } from "@/lib/openclaw/gateway-rpc";

export const runtime = "nodejs";

type Body = {
  url?: string;
  token?: string;
  password?: string;
  action?: "read" | "write";
  path?: string;
  content?: string;
  readMethod?: string;
  writeMethod?: string;
};

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Body;
    if (!body.url || !body.path || !body.action) {
      return NextResponse.json({ error: "Missing url, path or action." }, { status: 400 });
    }

    const auth = { token: body.token, password: body.password };
    const readMethod = body.readMethod || "workspace.read";
    const writeMethod = body.writeMethod || "workspace.write";

    if (body.action === "read") {
      const payload = await openclawRpc({
        url: body.url,
        auth,
        method: readMethod,
        params: { path: body.path },
      });
      return NextResponse.json({ ok: true, payload });
    }

    const payload = await openclawRpc({
      url: body.url,
      auth,
      method: writeMethod,
      params: { path: body.path, content: body.content ?? "" },
    });
    return NextResponse.json({ ok: true, payload });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Gateway docs API failed";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
