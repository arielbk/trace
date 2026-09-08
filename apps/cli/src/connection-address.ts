/**
 * The one address the local API uses, kept in a module that imports nothing.
 *
 * `serve.ts` and `connection-endpoint.ts` sit either side of an import cycle
 * (serve → setup-operations → connection-service → connection-endpoint →
 * serve), so a module graph entered at `serve.ts` used to read the port before
 * its declaration and produce `http://127.0.0.1:undefined`. A leaf module
 * cannot be caught half-evaluated, so both sides now read the same value
 * whichever door the process comes in through.
 */

/** Default port `trace serve` listens on. */
export const DEFAULT_SERVE_PORT = 4317;

/**
 * The one address the managed connection ever listens on. Hosted boards are
 * configured against it, so the managed runtime never moves to another port:
 * it either owns this endpoint or reports what is holding it.
 */
export const CONNECTION_ENDPOINT_ORIGIN = `http://127.0.0.1:${DEFAULT_SERVE_PORT}`;
