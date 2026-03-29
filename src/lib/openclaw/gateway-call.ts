import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { openclawRpc } from "@/lib/openclaw/gateway-rpc";

const execFileAsync = promisify(execFile);

type Auth = {
  token?: string;
  password?: string;
};

type CallOptions = {
  url: string;
  auth?: Auth;
  method: string;
  params?: Record<string, unknown>;
  timeoutMs?: number;
  expectFinal?: boolean;
};

function parseCliJson(stdout: string): unknown {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line.startsWith("{") && !line.startsWith("[")) continue;
    try {
      return JSON.parse(line) as unknown;
    } catch {
      // continue searching previous lines
    }
  }

  try {
    return JSON.parse(stdout) as unknown;
  } catch {
    return { raw: stdout };
  }
}

async function callViaCli(options: CallOptions): Promise<unknown> {
  const bin = process.env.OPENCLAW_GATEWAY_CLI_BIN || "openclaw";
  const args = ["gateway", "call", options.method, "--params", JSON.stringify(options.params ?? {})];
  if (options.url) args.push("--url", options.url);
  if (options.auth?.token) args.push("--token", options.auth.token);
  if (options.auth?.password) args.push("--password", options.auth.password);

  const { stdout, stderr } = await execFileAsync(bin, args, {
    timeout: options.timeoutMs ?? 15000,
    maxBuffer: 2 * 1024 * 1024,
    env: process.env,
  });

  if (stderr && stderr.trim().length > 0 && !stdout.trim().length) {
    throw new Error(stderr.trim());
  }

  return parseCliJson(stdout);
}

export async function callGateway(options: CallOptions): Promise<unknown> {
  const mode = (process.env.OPENCLAW_GATEWAY_TRANSPORT || "auto").toLowerCase();

  if (mode === "cli") {
    return await callViaCli(options);
  }

  if (mode === "ws") {
    return await openclawRpc({
      url: options.url,
      auth: options.auth,
      method: options.method,
      params: options.params,
      timeoutMs: options.timeoutMs,
      expectFinal: options.expectFinal,
    });
  }

  try {
    return await openclawRpc({
      url: options.url,
      auth: options.auth,
      method: options.method,
      params: options.params,
      timeoutMs: options.timeoutMs,
      expectFinal: options.expectFinal,
    });
  } catch (error) {
    const wsMessage = error instanceof Error ? error.message : String(error);
    try {
      return await callViaCli(options);
    } catch (cliError) {
      const cliMessage = cliError instanceof Error ? cliError.message : String(cliError);
      throw new Error(`Gateway call failed (ws + cli): ${wsMessage} | ${cliMessage}`);
    }
  }
}
