import { randomBytes, timingSafeEqual } from "node:crypto";

const SECRET_BYTES = 32;

export type BridgePairing = {
  readonly secret: string;
  exchange(secret: string): string | null;
};

/** Create one process-local capability that reveals the installation token once. */
export function createBridgePairing(credential: string): BridgePairing {
  const secret = randomBytes(SECRET_BYTES).toString("base64url");
  let available = true;

  return {
    secret,
    exchange(supplied: string): string | null {
      if (!available || !secretsMatch(supplied, secret)) return null;
      available = false;
      return credential;
    },
  };
}

/** Keep the one-time secret out of HTTP requests to the hosted application. */
export function createBridgePairingUrl(origin: string, secret: string): string {
  const url = new URL(origin);
  url.hash = new URLSearchParams({ "trace-pair": secret }).toString();
  return url.href;
}

function secretsMatch(supplied: string, expected: string): boolean {
  const suppliedBytes = Buffer.from(supplied);
  const expectedBytes = Buffer.from(expected);
  return (
    suppliedBytes.length === expectedBytes.length &&
    timingSafeEqual(suppliedBytes, expectedBytes)
  );
}
