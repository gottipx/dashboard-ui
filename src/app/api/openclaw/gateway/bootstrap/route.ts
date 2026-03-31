import { NextResponse } from "next/server";

import { openclawBridge } from "@/lib/openclaw/bridge";

export const runtime = "nodejs";

type Body = {
  force?: boolean;
};

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as Body;
    const force = Boolean(body.force);
    const state = await openclawBridge.sync(force || !openclawBridge.snapshot().lastSyncAt);

    const connected = state.connected;
    const healthState = connected ? (state.warnings.length > 0 ? "warning" : "healthy") : "warning";

    return NextResponse.json({
      ok: true,
      data: {
        connection: {
          transport: "cli",
          target: state.connectionTarget,
          configuredByServer: true,
        },
        status: {
          mode: "cli",
          pairing: connected ? "ok" : "warning",
          state: state.sourceStatus,
          lastSyncAt: state.lastSyncAt,
          warnings: state.warnings,
          error: !connected ? state.warnings[0] ?? "OpenClaw CLI unavailable" : undefined,
        },
        health: {
          ok: connected,
          state: healthState,
        },
        presence: {
          items: state.agents.map((agent) => ({
            id: agent.id,
            name: agent.name,
            state: agent.state,
            info: agent.info,
            workspace: agent.workspace,
          })),
        },
        nodes: {
          items: state.agents.map((agent) => ({
            id: agent.id,
            name: agent.name,
            state: agent.state,
            label: agent.info,
            workspace: agent.workspace,
          })),
        },
        sessions: {
          items: state.sessions,
        },
        runs: {
          items: state.runs.slice(0, 100),
        },
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "OpenClaw CLI bootstrap failed";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
