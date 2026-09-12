/**
 * The answer to one prompt. `cancelled` is a user-directed escape (Clack's
 * cancel symbol, normalised here) rather than an error, so callers never have to
 * know about Clack's sentinel value.
 */
export type PromptResult<T> = { cancelled: true } | { cancelled: false; value: T };

/**
 * The smallest interactive seam: ask a yes/no question and narrate around it.
 * A command that only needs a confirmation — `eqnx update` — depends on this
 * rather than on the whole setup picker, so its tests can be driven by a fake
 * that knows nothing about Integration Targets.
 */
export type ConfirmPrompt = {
  confirm(request: { message: string }): Promise<PromptResult<boolean>>;
  note(message: string, title: string): void;
  /** Renders an attention-grabbing terminal warning without changing exit status. */
  warn(message: string): void;
};
