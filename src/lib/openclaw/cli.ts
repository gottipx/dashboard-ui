import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function parseJsonFromStdout(stdout: string): unknown {
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
      // keep searching
    }
  }
  try {
    return JSON.parse(stdout) as unknown;
  } catch {
    return { raw: stdout };
  }
}

export async function runOpenclawCliJson(args: string[], timeoutMs = 15000): Promise<unknown> {
  const bin = process.env.OPENCLAW_GATEWAY_CLI_BIN || "openclaw";
  const { stdout } = await execFileAsync(bin, args, {
    timeout: timeoutMs,
    maxBuffer: 2 * 1024 * 1024,
    env: process.env,
  });
  return parseJsonFromStdout(stdout);
}
