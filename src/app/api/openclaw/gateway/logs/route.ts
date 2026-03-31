import { NextResponse } from "next/server";

import { openclawBridge } from "@/lib/openclaw/bridge";

export const runtime = "nodejs";

type Body = {
  agentId?: string;
  limit?: number;
  range?: "all" | "2h";
  force?: boolean;
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
    const snapshot = openclawBridge.snapshot();
    if (Boolean(body.force) || isStale(snapshot.lastSyncAt)) {
      await openclawBridge.sync();
    }

    const range = body.range === "2h" ? "2h" : "all";
    const limit = Math.max(50, Math.min(3000, Number(body.limit ?? 500)));
    const selected = openclawBridge.getLogs(body.agentId, range, limit);

    return NextResponse.json({
      ok: true,
      logs: selected.lines,
      source: selected.source,
      range,
      warning: selected.lines.length === 0 ? "No OpenClaw logs currently available." : undefined,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "OpenClaw logs failed";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
