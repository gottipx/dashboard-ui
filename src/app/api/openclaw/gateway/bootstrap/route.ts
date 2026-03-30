import { NextResponse } from "next/server";

import { runOpenclawCliJson } from "@/lib/openclaw/cli";

export const runtime = "nodejs";

function asObject(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" ? (input as Record<string, unknown>) : {};
}

function extractArray(payload: unknown, keys: string[]) {
  const obj = asObject(payload);
  for (const key of keys) {
    const value = obj[key];
    if (Array.isArray(value)) return value;
  }
  return [] as unknown[];
}

async function probeCli(argsOptions: string[][]) {
  const errors: string[] = [];
  for (const args of argsOptions) {
    try {
      return await runOpenclawCliJson(args, 12000);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${args.join(" ")}: ${message.split("\n")[0]}`);
    }
  }
  return { error: errors.join(" | ") };
}

export async function POST() {
  try {
    const [status, nodes, sessions, agents] = await Promise.all([
      probeCli([["status", "--json"], ["doctor", "--json"]]),
      probeCli([["nodes", "status", "--json"], ["nodes", "list", "--json"]]),
      probeCli([["sessions", "list", "--json"], ["session", "list", "--json"]]),
      probeCli([["agents", "list", "--json"], ["agent", "list", "--json"]]),
    ]);

    const nodesItems = extractArray(nodes, ["items", "nodes"]);
    const sessionsItems = extractArray(sessions, ["items", "sessions"]);
    const agentItems = extractArray(agents, ["items", "agents", "list"]);
    const statusObj = asObject(status);
    const hasError = typeof statusObj.error === "string";

    return NextResponse.json({
      ok: true,
      data: {
        connection: {
          transport: "cli",
          target: process.env.OPENCLAW_GATEWAY_CLI_BIN || "openclaw",
          configuredByServer: true,
        },
        status: status,
        health: {
          ok: !hasError,
          state: hasError ? "warning" : "healthy",
        },
        presence: {
          items: agentItems,
        },
        nodes: {
          items: nodesItems,
        },
        sessions: {
          items: sessionsItems,
        },
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "OpenClaw CLI bootstrap failed";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

