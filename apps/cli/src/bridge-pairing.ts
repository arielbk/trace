import { randomBytes, timingSafeEqual } from "node:crypto";

const SECRET_BYTES = 32;

/** How long a pairing link stays usable. Short enough that a link pasted into
 * a chat or left in shell history is dead by the time anyone finds it. */
export const PAIRING_LINK_TTL_MS = 5 * 60_000;

/** How many unused links may exist at once; creating another retires the
 * oldest, so an abandoned `trace connection pair` cannot accumulate authority. */
export const MAX_OUTSTANDING_PAIRING_LINKS = 5;

/** The label a browser paired through a link is recorded under. */
export const PAIRED_BROWSER_LABEL = "Paired browser";

export type PairingLink = {
  readonly secret: string;
  /** Epoch milliseconds after which the link no longer exchanges. */
  readonly expiresAt: number;
};

export type BrowserPairingRequest = PairingLink & { readonly code: string };

export const MAX_BROWSER_PAIRING_REQUESTS = 10;

export type PairingLinks = {
  request(): BrowserPairingRequest | null;
  approve(code: string): boolean;
  poll(
    secret: string,
  ): { status: "pending" } | { status: "approved"; token: string } | null;
  clear(): void;
  /** Mint a single-use link. Never restarts or otherwise disturbs the process. */
  create(): PairingLink;
  /** Exchange a link for one browser's persistent credential, or null. */
  exchange(secret: string): string | null;
};

type IssueBrowserToken = (label: string) => { id: string; token: string };

/**
 * The process-local set of outstanding pairing links. Links live only in
 * memory, so a restart invalidates every outstanding link while the browsers
 * that already completed an exchange keep their persisted credentials.
 */
export function createPairingLinks(
  issueBrowserToken: IssueBrowserToken,
  options: { now?: () => number } = {},
): PairingLinks {
  const now = options.now ?? Date.now;
  let outstanding: PairingLink[] = [];
  let requests: (BrowserPairingRequest & { approved: boolean })[] = [];
  const pruneRequests = () => {
    requests = requests.filter((request) => request.expiresAt > now());
  };

  const live = (): PairingLink[] =>
    outstanding.filter((link) => link.expiresAt > now());

  return {
    request() {
      pruneRequests();
      if (requests.length >= MAX_BROWSER_PAIRING_REQUESTS) return null;
      let code: string;
      do {
        const digits = randomBytes(4).toString("hex").toUpperCase();
        code = `${digits.slice(0, 4)}-${digits.slice(4)}`;
      } while (requests.some((request) => request.code === code));
      const request = {
        code,
        secret: randomBytes(SECRET_BYTES).toString("base64url"),
        expiresAt: now() + PAIRING_LINK_TTL_MS,
      };
      requests.push({ ...request, approved: false });
      return request;
    },
    approve(code) {
      pruneRequests();
      const request = requests.find((request) => request.code === code);
      if (!request || request.approved) return false;
      request.approved = true;
      return true;
    },
    poll(secret) {
      pruneRequests();
      const request = requests.find((request) =>
        secretsMatch(secret, request.secret),
      );
      if (!request) return null;
      if (!request.approved) return { status: "pending" };
      const { token } = issueBrowserToken(PAIRED_BROWSER_LABEL);
      requests = requests.filter((candidate) => candidate !== request);
      return { status: "approved", token };
    },
    clear() {
      outstanding = [];
      requests = [];
    },
    create(): PairingLink {
      const link: PairingLink = {
        secret: randomBytes(SECRET_BYTES).toString("base64url"),
        expiresAt: now() + PAIRING_LINK_TTL_MS,
      };
      outstanding = [...live(), link].slice(-MAX_OUTSTANDING_PAIRING_LINKS);
      return link;
    },

    exchange(supplied: string): string | null {
      const matched = live().find((link) =>
        secretsMatch(supplied, link.secret),
      );
      if (!matched) return null;
      outstanding = live().filter((link) => link !== matched);
      return issueBrowserToken(PAIRED_BROWSER_LABEL).token;
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
