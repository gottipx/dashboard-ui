type GatewayInput = {
  url?: string;
  token?: string;
  password?: string;
};

export function resolveGatewayRuntime(input?: GatewayInput) {
  const envUrl = process.env.OPENCLAW_GATEWAY_URL?.trim();
  const envToken = process.env.OPENCLAW_GATEWAY_TOKEN?.trim();
  const envPassword = process.env.OPENCLAW_GATEWAY_PASSWORD?.trim();
  const bodyUrl = input?.url?.trim();
  const bodyToken = input?.token?.trim();
  const bodyPassword = input?.password?.trim();

  return {
    url: bodyUrl || envUrl,
    auth: {
      token: bodyToken || envToken,
      password: bodyPassword || envPassword,
    },
    configuredByServer: Boolean(envUrl || envToken || envPassword || process.env.OPENCLAW_GATEWAY_CLI_BIN),
  };
}

