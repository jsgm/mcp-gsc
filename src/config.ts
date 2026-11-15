import type { Env } from "./env";

/** A misconfiguration whose message is safe to show to the user (never includes secret values). */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Trims whitespace and surrounding quotes that often sneak in when pasting secrets. */
export function cleanValue(value: string | undefined): string {
  return (value ?? "").trim().replace(/^(['"])(.*)\1$/s, "$2").trim();
}

type StringKeys = Exclude<
  {
    [K in keyof Env]-?: Env[K] extends string | undefined ? K : never;
  }[keyof Env],
  undefined
>;

export function requireString(env: Env, name: StringKeys): string {
  const value = cleanValue(env[name] as string | undefined);
  if (!value) throw new ConfigError(`${name} is not set. Add it in Workers → Settings → Variables and Secrets.`);
  return value;
}

export function requireHttpsUrl(env: Env, name: StringKeys): string {
  const value = requireString(env, name);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(
      `${name} is not a valid URL. Copy it from your Cloudflare Access application ` +
        `(it looks like https://<team>.cloudflareaccess.com/cdn-cgi/access/sso/oidc/<client_id>/...).`,
    );
  }
  if (url.protocol !== "https:") throw new ConfigError(`${name} must start with https://`);
  if (url.hostname.includes("<") || value.includes("<team>") || value.includes("<client_id>")) {
    throw new ConfigError(`${name} still contains the example placeholder. Replace it with the real value from Cloudflare Access.`);
  }
  return url.href;
}

export interface AccessConfig {
  clientId: string;
  clientSecret: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  keyEndpoint: string;
}

export function accessConfig(env: Env): AccessConfig {
  return {
    clientId: requireString(env, "CF_ACCESS_CLIENT_ID"),
    clientSecret: requireString(env, "CF_ACCESS_CLIENT_SECRET"),
    authorizationEndpoint: requireHttpsUrl(env, "CF_ACCESS_AUTHORIZATION_ENDPOINT"),
    tokenEndpoint: requireHttpsUrl(env, "CF_ACCESS_TOKEN_ENDPOINT"),
    keyEndpoint: requireHttpsUrl(env, "CF_ACCESS_KEY_ENDPOINT"),
  };
}
