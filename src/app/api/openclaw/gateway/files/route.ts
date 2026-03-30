import { NextResponse } from "next/server";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { runOpenclawCliJson } from "@/lib/openclaw/cli";

export const runtime = "nodejs";

type Body = {
  action?: "list" | "read" | "write";
  agentId?: string;
  path?: string;
  content?: string;
};

type FileEntry = {
  path: string;
  name: string;
  type: "file" | "directory";
};

function asObject(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" ? (input as Record<string, unknown>) : {};
}

function toArray(payload: unknown, keys: string[]) {
  const obj = asObject(payload);
  for (const key of keys) {
    const value = obj[key];
    if (Array.isArray(value)) return value;
  }
  return Array.isArray(payload) ? payload : [];
}

function normalizePath(p: string) {
  return p.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+/g, "/");
}

function safeResolve(baseDir: string, relativePath: string) {
  const normalizedRelative = relativePath.trim() === "." ? "" : normalizePath(relativePath);
  const absBase = path.resolve(baseDir);
  const resolved = path.resolve(absBase, normalizedRelative);
  if (resolved !== absBase && !resolved.startsWith(`${absBase}${path.sep}`)) {
    throw new Error("Path escapes workspace root.");
  }
  return { absBase, resolved };
}

async function firstSuccessfulCli(attempts: string[][]) {
  const errors: string[] = [];
  for (const args of attempts) {
    try {
      return await runOpenclawCliJson(args, 12000);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${args.join(" ")}: ${message.split("\n")[0]}`);
    }
  }
  throw new Error(`No OpenClaw CLI command succeeded. Tried: ${errors.join(" | ")}`);
}

async function discoverAgentWorkspace(agentId?: string) {
  if (!agentId?.trim()) return undefined;
  const needle = agentId.trim().toLowerCase();

  const probes = [
    ["agents", "list", "--json"],
    ["agent", "list", "--json"],
    ["nodes", "status", "--json"],
    ["nodes", "list", "--json"],
  ];

  for (const cmd of probes) {
    try {
      const payload = await runOpenclawCliJson(cmd, 12000);
      const rows = toArray(payload, ["items", "agents", "list", "nodes"]);
      for (const entry of rows) {
        const row = asObject(entry);
        const id = typeof row.id === "string" ? row.id.toLowerCase() : "";
        const name = typeof row.name === "string" ? row.name.toLowerCase() : "";
        if (id !== needle && name !== needle) continue;
        const workspace =
          typeof row.workspace === "string"
            ? row.workspace
            : typeof row.workspacePath === "string"
              ? row.workspacePath
              : typeof row.path === "string"
                ? row.path
                : undefined;
        if (workspace) return workspace;
      }
    } catch {
      // continue
    }
  }

  const configuredRoots = [
    process.env.OPENCLAW_AGENT_WORKSPACES_ROOT,
    process.env.OPENCLAW_WORKSPACES_ROOT,
    "/home/openclaw/.openclaw/agents",
    "/home/openclaw/.openclaw/workspaces",
    "/home/openclaw/.openclaw",
  ].filter(Boolean) as string[];

  for (const root of configuredRoots) {
    try {
      const direct = path.resolve(root, agentId);
      const directMeta = await stat(direct);
      if (directMeta.isDirectory()) return direct;
    } catch {
      // continue
    }
    try {
      const children = await readdir(root, { withFileTypes: true });
      const match = children.find((entry) => entry.isDirectory() && entry.name.toLowerCase() === needle);
      if (match) return path.resolve(root, match.name);
    } catch {
      // continue
    }
  }

  return undefined;
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Body;
    const filePath = (body.path || ".").trim();
    const workspace = await discoverAgentWorkspace(body.agentId);

    if (!workspace) {
      return NextResponse.json(
        {
          ok: false,
          error: "Could not resolve agent workspace path from OpenClaw CLI. Set OPENCLAW_AGENT_WORKSPACES_ROOT if needed.",
        },
        { status: 500 }
      );
    }

    if (body.action === "list") {
      const { absBase, resolved } = safeResolve(workspace, filePath);
      const meta = await stat(resolved);
      const directory = meta.isDirectory() ? resolved : path.dirname(resolved);
      const entries = await readdir(directory, { withFileTypes: true });
      const normalizedEntries: FileEntry[] = entries
        .map((entry) => {
          const full = path.resolve(directory, entry.name);
          const rel = normalizePath(path.relative(absBase, full) || ".");
          return {
            path: rel,
            name: entry.name,
            type: entry.isDirectory() ? "directory" : "file",
          } as FileEntry;
        })
        .filter((entry) => entry.path !== ".")
        .sort((a, b) => {
          if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
      return NextResponse.json({ ok: true, method: "cli.fs", path: filePath, entries: normalizedEntries });
    }

    if (body.action === "read") {
      const { resolved } = safeResolve(workspace, filePath);
      const content = await readFile(resolved, "utf8");
      return NextResponse.json({ ok: true, method: "cli.fs", path: filePath, content });
    }

    if (body.action === "write") {
      const { resolved } = safeResolve(workspace, filePath);
      await mkdir(path.dirname(resolved), { recursive: true });
      await writeFile(resolved, body.content ?? "", "utf8");
      return NextResponse.json({ ok: true, method: "cli.fs", path: filePath });
    }

    // tiny CLI smoke probe for unsupported action cases
    await firstSuccessfulCli([["status", "--json"]]);
    return NextResponse.json({ error: "Unsupported action." }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Agent files CLI failed";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
