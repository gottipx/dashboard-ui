import { NextResponse } from "next/server";

import { openclawBridge } from "@/lib/openclaw/bridge";

export const runtime = "nodejs";

type Body = {
  action?: "list" | "create";
  force?: boolean;
  agent?: {
    id?: string;
    name?: string;
    workspace?: string;
  };
};

function isStale(lastSyncAt: string | null, maxAgeMs = 25000) {
  if (!lastSyncAt) return true;
  const at = new Date(lastSyncAt).getTime();
  if (Number.isNaN(at)) return true;
  return Date.now() - at > maxAgeMs;
}

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as Body;
    const action = body.action ?? "list";

    if (action === "create") {
      const id = body.agent?.id?.trim() ?? "";
      const name = body.agent?.name?.trim() ?? "";
      const workspace = body.agent?.workspace?.trim();
      if (!id || !name) {
        return NextResponse.json({ ok: false, error: "Missing agent id or name." }, { status: 400 });
      }
      const created = await openclawBridge.createAgent({ id, name, workspace });
      return NextResponse.json({
        ok: true,
        agent: { id, name, workspace: workspace || undefined },
        source: created.source,
        payload: created.payload,
      });
    }

    const snapshot = openclawBridge.snapshot();
    const shouldSync = Boolean(body.force) || isStale(snapshot.lastSyncAt);
    const state = shouldSync ? await openclawBridge.sync() : snapshot;

    return NextResponse.json({
      ok: true,
      agents: state.agents,
      source: shouldSync ? "bridge.sync" : "bridge.cache",
      warning: state.warnings.length > 0 ? state.warnings.join(" | ") : undefined,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "OpenClaw agents CLI failed";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
