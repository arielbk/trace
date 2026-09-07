/**
 * The board remains same-origin by default. A hosted build points the exact
 * same client at local Trace through VITE_TRACE_API_ORIGIN.
 */
export function resolveTraceApiOrigin(value: string | undefined): string {
  const configured = value?.trim();
  if (!configured) return "";

  try {
    const url = new URL(configured);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      throw new Error();
    }
    return url.origin;
  } catch {
    throw new Error("VITE_TRACE_API_ORIGIN must be an HTTP origin");
  }
}

export const traceApiOrigin = resolveTraceApiOrigin(
  import.meta.env.VITE_TRACE_API_ORIGIN,
);

export const usesRemoteTraceApi = traceApiOrigin !== "";

export function traceApiUrl(
  path: string,
  origin: string = traceApiOrigin,
): string {
  if (!path.startsWith("/")) {
    throw new Error("Trace API paths must start with /");
  }
  return `${origin}${path}`;
}

type LocalNetworkRequestInit = RequestInit & {
  /** Chrome Local Network Access intent; ignored by browsers that predate it. */
  targetAddressSpace: "loopback";
};

/**
 * Fetch from Trace's API. Hosted builds explicitly identify the destination as
 * loopback so supporting browsers can ask for Local Network Access permission
 * and safely relax mixed-content blocking for this request.
 */
export function traceApiFetch(
  path: string,
  init?: RequestInit,
  origin: string = traceApiOrigin,
): Promise<Response> {
  const url = traceApiUrl(path, origin);
  if (!origin) return init ? fetch(url, init) : fetch(url);

  const localInit: LocalNetworkRequestInit = {
    ...init,
    targetAddressSpace: "loopback",
  };
  return fetch(url, localInit);
}
