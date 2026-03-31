import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function sanitizeSecrets(input: string) {
  return input
    .replace(/(--token\s+)([^\s]+)/gi, "$1***")
    .replace(/(--password\s+)([^\s]+)/gi, "$1***")
    .replace(/(token=)([^\s&]+)/gi, "$1***")
    .replace(/(password=)([^\s&]+)/gi, "$1***")
    .replace(/("token"\s*:\s*")([^"]+)(")/gi, '$1***$3')
    .replace(/("password"\s*:\s*")([^"]+)(")/gi, '$1***$3');
}

function resolveCliProcess(args: string[]) {
  const bin = process.env.OPENCLAW_GATEWAY_CLI_BIN || "openclaw";
  const prefix = process.env.OPENCLAW_GATEWAY_CLI_PREFIX?.trim();
  if (!prefix) {
    return { cmd: bin, cmdArgs: args };
  }
  const parts = prefix.split(/\s+/).filter(Boolean);
  const cmd = parts[0];
  const cmdArgs = [...parts.slice(1), bin, ...args];
  return { cmd, cmdArgs };
}

function parseJsonFromStdout(stdout: string): unknown {
  const trimmedStdout = stdout.trim();
  if (!trimmedStdout) return {};
  try {
    return JSON.parse(trimmedStdout) as unknown;
  } catch {
    // continue with line-wise parsing
  }

  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const parsedJsonLines: unknown[] = [];
  for (const line of lines) {
    if (!line.startsWith("{") && !line.startsWith("[")) continue;
    try {
      parsedJsonLines.push(JSON.parse(line) as unknown);
    } catch {
      // ignore malformed line
    }
  }
  if (parsedJsonLines.length === 1) return parsedJsonLines[0];
  if (parsedJsonLines.length > 1) return parsedJsonLines;

  return { raw: stdout };
}

export async function runOpenclawCliJson(args: string[], timeoutMs = 15000): Promise<unknown> {
  const processSpec = resolveCliProcess(args);
  try {
    const { stdout } = await execFileAsync(processSpec.cmd, processSpec.cmdArgs, {
      timeout: timeoutMs,
      maxBuffer: 2 * 1024 * 1024,
      env: process.env,
    });
    return parseJsonFromStdout(stdout);
  } catch (error) {
    const details =
      typeof error === "object" && error !== null
        ? String((error as { stderr?: string }).stderr ?? (error as { message?: string }).message ?? "OpenClaw CLI failed")
        : String(error);
    throw new Error(sanitizeSecrets(details.trim()));
  }
}
