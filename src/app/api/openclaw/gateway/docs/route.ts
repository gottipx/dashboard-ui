import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST() {
  return NextResponse.json(
    {
      ok: false,
      error: "Docs route deprecated. Use /api/openclaw/gateway/files with CLI-only integration.",
    },
    { status: 410 }
  );
}

