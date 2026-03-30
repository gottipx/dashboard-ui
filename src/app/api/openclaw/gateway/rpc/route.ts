import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST() {
  return NextResponse.json(
    {
      ok: false,
      error: "RPC route disabled. AgenticOS now uses OpenClaw CLI-only integration.",
    },
    { status: 410 }
  );
}

