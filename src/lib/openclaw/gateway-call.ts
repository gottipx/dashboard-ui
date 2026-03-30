import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type Auth = {
  token?: string;
  password?: string;
};

type CallOptions = {
  url?: string;
  auth?: Auth;
  method: string;
  params?: Record<string, unknown>;
  timeoutMs?: number;
  expectFinal?: boolean;
};

function redactSecrets(message: string, auth?: Auth): string {
  let out = message;
  out = out.replace(/--token\s+\S+/gi, "--token ***");
  out = out.replace(/--password\s+\S+/gi, "--password ***");
  const secrets = [
    auth?.token,
    auth?.password,
    process.env.OPENCLAW_GATEWAY_TOKEN,
    process.env.OPENCLAW_GATEWAY_PASSWORD,
  ].filter(Boolean) as string[];
  for (const secret of secrets) {
    out = out.split(secret).join("***");
  }
  return out;
}

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
  const auth: Auth = {
    token: options.auth?.token || process.env.OPENCLAW_GATEWAY_TOKEN,
    password: options.auth?.password || process.env.OPENCLAW_GATEWAY_PASSWORD,
  };
  const bin = process.env.OPENCLAW_GATEWAY_CLI_BIN || "openclaw";
  const prefix = process.env.OPENCLAW_GATEWAY_CLI_PREFIX?.trim();
  const args = ["gateway", "call", options.method, "--params", JSON.stringify(options.params ?? {})];
  if (options.url?.trim()) args.push("--url", options.url.trim());
  if (auth.token) args.push("--token", auth.token);
  if (auth.password) args.push("--password", auth.password);
  const command = !prefix ? bin : prefix.split(/\s+/).filter(Boolean)[0];
  const commandArgs = !prefix
    ? args
    : [...prefix.split(/\s+/).filter(Boolean).slice(1), bin, ...args];

  let stdout = "";
  let stderr = "";
  try {
    const result = await execFileAsync(command, commandArgs, {
      timeout: options.timeoutMs ?? 15000,
      maxBuffer: 2 * 1024 * 1024,
      env: process.env,
    });
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(redactSecrets(message, auth));
  }

  if (stderr && stderr.trim().length > 0 && !stdout.trim().length) {
    throw new Error(redactSecrets(stderr.trim(), auth));
  }

  return parseCliJson(stdout);
}

export async function callGateway(options: CallOptions): Promise<unknown> {
  const auth: Auth = {
    token: options.auth?.token || process.env.OPENCLAW_GATEWAY_TOKEN,
    password: options.auth?.password || process.env.OPENCLAW_GATEWAY_PASSWORD,
  };
  const mode = (process.env.OPENCLAW_GATEWAY_TRANSPORT || "cli").toLowerCase();

  if (mode === "cli") {
    return await callViaCli(options);
  }

  if (mode === "ws") {
    const { openclawRpc } = await import("@/lib/openclaw/gateway-rpc");
    if (!options.url?.trim()) {
      throw new Error("Gateway URL is required for ws transport.");
    }
    return await openclawRpc({
      url: options.url.trim(),
      auth,
      method: options.method,
      params: options.params,
      timeoutMs: options.timeoutMs,
      expectFinal: options.expectFinal,
    });
  }

  try {
    const { openclawRpc } = await import("@/lib/openclaw/gateway-rpc");
    if (!options.url?.trim()) {
      throw new Error("Gateway URL is required for ws transport.");
    }
    return await openclawRpc({
      url: options.url.trim(),
      auth,
      method: options.method,
      params: options.params,
      timeoutMs: options.timeoutMs,
      expectFinal: options.expectFinal,
    });
  } catch (error) {
    const wsMessage = redactSecrets(error instanceof Error ? error.message : String(error), auth);
    try {
      return await callViaCli({ ...options, auth });
    } catch (cliError) {
      const cliMessage = redactSecrets(cliError instanceof Error ? cliError.message : String(cliError), auth);
      throw new Error(`Gateway call failed (ws + cli): ${wsMessage} | ${cliMessage}`);
    }
  }
}
