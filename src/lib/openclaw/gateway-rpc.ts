import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

type GatewayAuth = {
  token?: string;
  password?: string;
};

type RpcOptions = {
  url: string;
  auth?: GatewayAuth;
  method: string;
  params?: Record<string, unknown>;
  timeoutMs?: number;
  expectFinal?: boolean;
};

type StoredDevice = {
  id: string;
  publicKey: string;
  privateKeyPem: string;
};

type RpcFrame = {
  type: "req" | "res" | "event";
  id?: string;
  method?: string;
  params?: Record<string, unknown>;
  ok?: boolean;
  payload?: unknown;
  error?: unknown;
  event?: string;
};

const PROTOCOL_VERSION = 3;
const DEVICE_FILE = path.join(process.cwd(), ".openclaw-dashboard-device.json");

function randomId() {
  return crypto.randomUUID();
}

function loadOrCreateDevice(): StoredDevice {
  try {
    if (fs.existsSync(DEVICE_FILE)) {
      const raw = fs.readFileSync(DEVICE_FILE, "utf8");
      const parsed = JSON.parse(raw) as StoredDevice;
      if (parsed.id && parsed.publicKey && parsed.privateKeyPem) return parsed;
    }
  } catch {
    // fall through and recreate device identity
  }

  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyDer = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  const publicKeyBase64 = publicKeyDer.toString("base64");
  const privateKeyPem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const idHash = crypto.createHash("sha256").update(publicKeyBase64).digest("hex").slice(0, 24);
  const device: StoredDevice = {
    id: `dashboard-${idHash}`,
    publicKey: publicKeyBase64,
    privateKeyPem,
  };
  fs.writeFileSync(DEVICE_FILE, JSON.stringify(device, null, 2), "utf8");
  return device;
}

function buildConnectParams(args: { auth?: GatewayAuth; nonce?: string }): Record<string, unknown> {
  const device = loadOrCreateDevice();
  const signedAt = Date.now();

  let signature: string | undefined;
  if (args.nonce) {
    const privateKey = crypto.createPrivateKey(device.privateKeyPem);
    signature = crypto.sign(null, Buffer.from(args.nonce), privateKey).toString("base64");
  }

  return {
    minProtocol: PROTOCOL_VERSION,
    maxProtocol: PROTOCOL_VERSION,
    client: {
      id: "agenticos-dashboard",
      version: "0.1.0",
      platform: "web",
      mode: "operator",
      instanceId: device.id,
    },
    role: "operator",
    scopes: ["operator.read", "operator.write", "operator.pairing", "operator.admin", "operator.approvals"],
    caps: [],
    commands: [],
    permissions: {},
    auth: args.auth?.token
      ? { token: args.auth.token }
      : args.auth?.password
        ? { password: args.auth.password }
        : {},
    locale: "en-US",
    userAgent: "agenticos-dashboard/0.1.0",
    device: {
      id: device.id,
      publicKey: device.publicKey,
      signature,
      signedAt,
      nonce: args.nonce,
    },
  };
}

function normalizeError(err: unknown) {
  if (!err) return "Unknown gateway error";
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return "Unknown gateway error";
  }
}

export async function openclawRpc<T = unknown>(options: RpcOptions): Promise<T> {
  const WebSocketCtor = globalThis.WebSocket;
  if (!WebSocketCtor) {
    throw new Error("WebSocket is not available in this runtime.");
  }

  const timeoutMs = options.timeoutMs ?? 15000;
  const ws = new WebSocketCtor(options.url);
  const connectId = randomId();
  const rpcId = randomId();

  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    let connectSent = false;
    let challengeNonce: string | undefined;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // ignore close errors
      }
      fn();
    };

    const timer = setTimeout(() => {
      finish(() => reject(new Error(`Gateway RPC timeout (${options.method})`)));
    }, timeoutMs);

    const sendConnect = () => {
      if (connectSent) return;
      connectSent = true;
      const frame: RpcFrame = {
        type: "req",
        id: connectId,
        method: "connect",
        params: buildConnectParams({ auth: options.auth, nonce: challengeNonce }),
      };
      ws.send(JSON.stringify(frame));
    };

    ws.addEventListener("open", () => {
      // gateway usually sends connect.challenge first; fallback-connect if not
      setTimeout(() => {
        if (!connectSent && !settled) sendConnect();
      }, 200);
    });

    ws.addEventListener("message", (event) => {
      let frame: RpcFrame;
      try {
        frame = JSON.parse(String(event.data)) as RpcFrame;
      } catch {
        return;
      }

      if (frame.type === "event" && frame.event === "connect.challenge") {
        const payload = (frame.payload ?? {}) as Record<string, unknown>;
        challengeNonce = typeof payload.nonce === "string" ? payload.nonce : undefined;
        sendConnect();
        return;
      }

      if (frame.type === "res" && frame.id === connectId) {
        if (!frame.ok) {
          finish(() => reject(new Error(`Gateway connect failed: ${normalizeError(frame.error)}`)));
          return;
        }
        const requestFrame: RpcFrame = {
          type: "req",
          id: rpcId,
          method: options.method,
          params: options.params ?? {},
        };
        ws.send(JSON.stringify(requestFrame));
        return;
      }

      if (frame.type === "res" && frame.id === rpcId) {
        if (!frame.ok) {
          finish(() => reject(new Error(`Gateway ${options.method} failed: ${normalizeError(frame.error)}`)));
          return;
        }

        const payload = frame.payload as Record<string, unknown> | undefined;
        if (options.expectFinal) {
          const status = typeof payload?.status === "string" ? payload.status : "";
          if (status === "accepted") return;
        }

        finish(() => resolve((frame.payload ?? null) as T));
      }
    });

    ws.addEventListener("error", () => {
      finish(() => reject(new Error(`WebSocket error while calling ${options.method}`)));
    });

    ws.addEventListener("close", () => {
      if (!settled) {
        finish(() => reject(new Error(`Gateway socket closed before ${options.method} completed`)));
      }
    });
  });
}
