import { NextResponse } from "next/server";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { callGateway } from "@/lib/openclaw/gateway-call";
import { resolveGatewayRuntime } from "@/lib/openclaw/runtime-config";

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
  size?: number;
};

function asObject(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" ? (input as Record<string, unknown>) : {};
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

async function loadAgentWorkspace(args: {
  url?: string;
  auth: { token?: string; password?: string };
  agentId?: string;
}) {
  if (!args.agentId?.trim()) return undefined;
  try {
    const payload = await callGateway({
      url: args.url,
      auth: args.auth,
      method: "config.get",
      params: {},
      timeoutMs: 10000,
    });
    const root = asObject(payload);
    const config = asObject(asObject(root.config).config ?? root.value ?? root.config ?? root);
    const agents = asObject(config.agents);
    const list = Array.isArray(agents.list) ? agents.list : [];
    const needle = args.agentId.trim().toLowerCase();
    const hit = list.find((entry) => {
      const row = asObject(entry);
      const id = typeof row.id === "string" ? row.id.toLowerCase() : "";
      const name = typeof row.name === "string" ? row.name.toLowerCase() : "";
      return id === needle || name === needle;
    });
    const workspace = typeof asObject(hit).workspace === "string" ? String(asObject(hit).workspace) : undefined;
    return workspace;
  } catch {
    return undefined;
  }
}

async function tryMethods(args: {
  url?: string;
  auth: { token?: string; password?: string };
  methods: string[];
  paramsBuilder: (method: string) => Record<string, unknown>;
}) {
  const errors: string[] = [];
  for (const method of args.methods) {
    try {
      const payload = await callGateway({
        url: args.url,
        auth: args.auth,
        method,
        params: args.paramsBuilder(method),
        timeoutMs: 20000,
      });
      return { method, payload };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${method}: ${message.split("\n")[0]}`);
    }
  }
  throw new Error(`No supported file method succeeded. Tried: ${errors.join(" | ")}`);
}

function normalizeFileEntries(payload: unknown, basePath: string): FileEntry[] {
  const container = asObject(payload);
  const candidates = Array.isArray(container.items)
    ? container.items
    : Array.isArray(container.files)
      ? container.files
      : Array.isArray(container.entries)
        ? container.entries
        : Array.isArray(payload)
          ? payload
          : [];

  return candidates.map((entry, idx) => {
    const row = asObject(entry);
    const fullPath =
      typeof row.path === "string"
        ? row.path
        : typeof row.fullPath === "string"
          ? row.fullPath
          : typeof row.name === "string"
            ? `${basePath.replace(/\/+$/, "")}/${row.name}`.replace(/^\/+/, "")
            : `${basePath.replace(/\/+$/, "")}/entry-${idx + 1}`.replace(/^\/+/, "");
    const name =
      typeof row.name === "string"
        ? row.name
        : fullPath.split("/").filter(Boolean).at(-1) || `entry-${idx + 1}`;
    const typeRaw = String(row.type ?? row.kind ?? "");
    const isDir = typeRaw.toLowerCase().includes("dir") || Boolean(row.isDir) || Boolean(row.directory);
    return {
      path: fullPath,
      name,
      type: isDir ? "directory" : "file",
      size: typeof row.size === "number" ? row.size : undefined,
    };
  });
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Body;
    const runtime = resolveGatewayRuntime({});
    const auth = runtime.auth;
    const url = runtime.url;
    const filePath = (body.path || ".").trim();
    const agentId = body.agentId?.trim();
    const workspace = await loadAgentWorkspace({ url, auth, agentId });

    if (workspace) {
      if (body.action === "list") {
        const { absBase, resolved } = safeResolve(workspace, filePath);
        const meta = await stat(resolved);
        const directory = meta.isDirectory() ? resolved : path.dirname(resolved);
        const entries = await readdir(directory, { withFileTypes: true });
        const normalizedEntries = entries
          .map((entry) => {
            const full = path.resolve(directory, entry.name);
            const rel = normalizePath(path.relative(absBase, full) || ".");
            return {
              path: rel,
              name: entry.name,
              type: entry.isDirectory() ? "directory" : "file",
            } satisfies FileEntry;
          })
          .filter((entry) => entry.path !== ".")
          .sort((a, b) => {
            if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
            return a.name.localeCompare(b.name);
          });
        return NextResponse.json({ ok: true, method: "fs.workspace", path: filePath, entries: normalizedEntries });
      }

      if (body.action === "read") {
        const { resolved } = safeResolve(workspace, filePath);
        const content = await readFile(resolved, "utf8");
        return NextResponse.json({ ok: true, method: "fs.workspace", path: filePath, content });
      }

      if (body.action === "write") {
        const { resolved } = safeResolve(workspace, filePath);
        await mkdir(path.dirname(resolved), { recursive: true });
        await writeFile(resolved, body.content ?? "", "utf8");
        return NextResponse.json({ ok: true, method: "fs.workspace", path: filePath });
      }
    }

    if (body.action === "list") {
      const result = await tryMethods({
        url,
        auth,
        methods: ["workspace.list", "workspace.ls", "fs.list", "file.list", "workspace.tree"],
        paramsBuilder: () => ({
          path: filePath,
          agentId,
          agent: agentId,
          nodeId: agentId,
          recursive: false,
        }),
      });
      const entries = normalizeFileEntries(result.payload, filePath)
        .filter((entry) => entry.path !== ".")
        .sort((a, b) => {
          if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
      return NextResponse.json({ ok: true, method: result.method, path: filePath, entries });
    }

    if (body.action === "read") {
      const result = await tryMethods({
        url,
        auth,
        methods: ["workspace.read", "fs.read", "file.read"],
        paramsBuilder: () => ({
          path: filePath,
          agentId,
          agent: agentId,
          nodeId: agentId,
        }),
      });
      const payload = asObject(result.payload);
      const content =
        typeof payload.content === "string"
          ? payload.content
          : typeof payload.text === "string"
            ? payload.text
            : typeof result.payload === "string"
              ? result.payload
              : JSON.stringify(result.payload, null, 2);
      return NextResponse.json({ ok: true, method: result.method, path: filePath, content });
    }

    if (body.action === "write") {
      const result = await tryMethods({
        url,
        auth,
        methods: ["workspace.write", "fs.write", "file.write"],
        paramsBuilder: () => ({
          path: filePath,
          content: body.content ?? "",
          agentId,
          agent: agentId,
          nodeId: agentId,
        }),
      });
      return NextResponse.json({ ok: true, method: result.method, path: filePath, payload: result.payload });
    }

    return NextResponse.json({ error: "Unsupported action." }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Agent files API failed";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
