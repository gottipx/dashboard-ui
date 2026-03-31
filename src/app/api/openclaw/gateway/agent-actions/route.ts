import { NextResponse } from "next/server";

import { openclawBridge } from "@/lib/openclaw/bridge";

export const runtime = "nodejs";

type Body = {
  action?:
    | "sessions"
    | "chat"
    | "dispatch-task"
    | "session-history"
    | "delete-session"
    | "models-list"
    | "model-status"
    | "model-set-agent-default";
  force?: boolean;
  agentId?: string;
  sessionId?: string;
  sessionKey?: string;
  limit?: number;
  model?: string;
  message?: string;
  kind?: "task" | "issue" | "project";
  task?: {
    id?: string;
    title?: string;
    description?: string;
    project?: string;
    priority?: string;
    status?: string;
    agent?: string;
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
    const snapshot = openclawBridge.snapshot();
    if (Boolean(body.force) || isStale(snapshot.lastSyncAt)) {
      await openclawBridge.sync();
    }

    if (body.action === "sessions") {
      let sessions = openclawBridge.getSessions(body.agentId);
      if (sessions.length === 0 && !body.force) {
        await openclawBridge.sync(true);
        sessions = openclawBridge.getSessions(body.agentId);
      }
      const source = sessions.length > 0 ? "bridge.sessions" : "bridge.sync";
      return NextResponse.json({
        ok: true,
        sessions,
        source,
        warning: sessions.length === 0 ? "No sessions currently reported by OpenClaw." : undefined,
      });
    }

    if (body.action === "chat") {
      const message = body.message?.trim();
      const agentId = body.agentId?.trim();
      if (!message || !agentId) {
        return NextResponse.json({ ok: false, error: "Agent and message are required." }, { status: 400 });
      }
      const sessionId = body.sessionId?.trim();
      const result = await openclawBridge.sendChat(agentId, message, sessionId);
      return NextResponse.json({
        ok: true,
        payload: result.payload,
        text: result.text,
        source: result.source,
        runId: result.runId,
        sessionId: result.sessionId,
      });
    }

    if (body.action === "session-history") {
      const agentId = body.agentId?.trim();
      const sessionId = body.sessionId?.trim();
      const sessionKey = body.sessionKey?.trim();
      if (!agentId || (!sessionId && !sessionKey)) {
        return NextResponse.json({ ok: true, messages: [] });
      }
      const limit = Math.max(20, Math.min(50000, Number(body.limit ?? 5000)));
      const messages = await openclawBridge.getSessionHistory(agentId, sessionId ?? "", limit, sessionKey);
      return NextResponse.json({ ok: true, messages });
    }

    if (body.action === "delete-session") {
      const agentId = body.agentId?.trim();
      const sessionId = body.sessionId?.trim();
      const sessionKey = body.sessionKey?.trim();
      if (!agentId || !sessionId) {
        return NextResponse.json({ ok: false, error: "Agent and session are required." }, { status: 400 });
      }
      const result = await openclawBridge.deleteSession(agentId, sessionId, sessionKey);
      return NextResponse.json({ ok: true, ...result });
    }

    if (body.action === "models-list") {
      const result = await openclawBridge.listModels();
      return NextResponse.json({ ok: true, models: result.models, source: result.source });
    }

    if (body.action === "model-status") {
      const agentId = body.agentId?.trim();
      const result = await openclawBridge.getModelStatus(agentId);
      return NextResponse.json({ ok: true, model: result.model, source: result.source, payload: result.payload });
    }

    if (body.action === "model-set-agent-default") {
      const agentId = body.agentId?.trim();
      const model = body.model?.trim();
      if (!agentId || !model) {
        return NextResponse.json({ ok: false, error: "Agent and model are required." }, { status: 400 });
      }
      const result = await openclawBridge.setAgentDefaultModel(agentId, model);
      return NextResponse.json({ ok: true, source: result.source });
    }

    if (body.action === "dispatch-task") {
      const task = body.task ?? {};
      const agentId = (body.agentId || task.agent || "").trim();
      const title = (task.title || "").trim();
      if (!agentId || !title) {
        return NextResponse.json({ ok: false, error: "Task title and target agent are required." }, { status: 400 });
      }
      const kind = body.kind ?? "task";
      const input = {
        id: task.id,
        title,
        description: task.description || "",
        project: task.project || "",
        priority: task.priority || "Medium",
        status: task.status || "Todo",
      };
      const result = await openclawBridge.delegate(kind, agentId, input);
      return NextResponse.json({ ok: true, payload: result.payload, source: result.source, runId: result.runId });
    }

    return NextResponse.json({ ok: false, error: "Unsupported action." }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Agent actions CLI failed";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
