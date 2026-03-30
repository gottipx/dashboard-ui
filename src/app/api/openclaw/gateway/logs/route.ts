import { NextResponse } from "next/server";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

import { runOpenclawCliJson } from "@/lib/openclaw/cli";

export const runtime = "nodejs";

type Body = {
  agentId?: string;
  limit?: number;
};

function extractFirstLogPath(payload: unknown): string | undefined {
  const stack: unknown[] = [payload];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    if (typeof current === "string") {
      const looksLikeLog = current.includes(".log") && (current.includes("/tmp/") || current.includes("/var/") || current.includes("/home/"));
      if (looksLikeLog) return current;
      continue;
    }
    if (Array.isArray(current)) {
      for (const item of current) stack.push(item);
      continue;
    }
    if (typeof current === "object") {
      for (const value of Object.values(current as Record<string, unknown>)) stack.push(value);
    }
  }
  return undefined;
}

async function resolveLogPathFromStatus() {
  try {
    const statusPayload = await runOpenclawCliJson(["status", "--json"], 10000);
    return extractFirstLogPath(statusPayload);
  } catch {
    return undefined;
  }
}

async function latestLogInDir(dir: string) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const logFiles = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".log")).map((entry) => path.resolve(dir, entry.name));
    let latest: { file: string; mtime: number } | null = null;
    for (const file of logFiles) {
      try {
        const info = await stat(file);
        if (!latest || info.mtimeMs > latest.mtime) {
          latest = { file, mtime: info.mtimeMs };
        }
      } catch {
        // ignore unreadable files
      }
    }
    return latest?.file;
  } catch {
    return undefined;
  }
}

async function resolveLogPath() {
  const fromStatus = await resolveLogPathFromStatus();
  if (fromStatus) return fromStatus;
  const candidates = [
    process.env.OPENCLAW_LOG_DIR,
    "/tmp/openclaw",
    "/var/log/openclaw",
    "/home/openclaw/.openclaw/logs",
  ].filter(Boolean) as string[];
  for (const dir of candidates) {
    const file = await latestLogInDir(dir);
    if (file) return file;
  }
  return undefined;
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Body;
    const limit = Math.max(50, Math.min(2000, Number(body.limit ?? 400)));
    const agentId = body.agentId?.trim().toLowerCase();
    const logPath = await resolveLogPath();
    if (!logPath) {
      return NextResponse.json({ ok: true, logs: [], source: "none", warning: "No OpenClaw log file found." });
    }
    const content = await readFile(logPath, "utf8");
    const lines = content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const filtered = agentId ? lines.filter((line) => line.toLowerCase().includes(agentId)) : lines;
    const useLines = (filtered.length > 0 ? filtered : lines).slice(-limit);
    return NextResponse.json({
      ok: true,
      logs: useLines,
      source: logPath,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "OpenClaw logs failed";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
