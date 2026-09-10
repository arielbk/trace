import { validateServerUrl } from "./config-operations.ts";
import * as clackPrompts from "@clack/prompts";
import type {
  PromptResult,
  SetupPrompt,
  TargetSelectionRequest,
} from "./setup-prompt.ts";

/** One renderable choice in Clack's grouped multiselect. */
type ClackOption = { value: string; label: string; hint?: string };

/**
 * The slice of `@clack/prompts` the adapter uses. Narrowed to what setup needs
 * so the mapping can be driven by a fake without a TTY — the real terminal
 * behavior is the one thing left for human review.
 */
export type ClackApi = {
  groupMultiselect(options: {
    message: string;
    options: Record<string, ClackOption[]>;
    initialValues: string[];
    required: boolean;
    selectableGroups: boolean;
  }): Promise<string[] | symbol>;
  confirm(options: {
    message: string;
    initialValue: boolean;
  }): Promise<boolean | symbol>;
  text(options: {
    message: string;
    placeholder: string;
    validate(value: string | undefined): string | undefined;
  }): Promise<string | symbol>;
  note(message?: string, title?: string): void;
  warn(message: string): void;
  isCancel(value: unknown): boolean;
};

const defaultClack: ClackApi = {
  groupMultiselect: (options) => clackPrompts.groupMultiselect(options),
  confirm: (options) => clackPrompts.confirm(options),
  text: (options) => clackPrompts.text(options),
  note: (message, title) => {
    clackPrompts.note(message, title);
  },
  warn: (message) => {
    clackPrompts.log.warn(message);
  },
  isCancel: (value) => clackPrompts.isCancel(value),
};

/**
 * The terminal implementation of {@link SetupPrompt}. Clack's cancel sentinel
 * stops here: everything above the seam sees a plain `PromptResult`.
 */
export function createClackPrompt(clack: ClackApi = defaultClack): SetupPrompt {
  return {
    async selectTargets(
      request: TargetSelectionRequest,
    ): Promise<PromptResult<string[]>> {
      const options: Record<string, ClackOption[]> = {};
      for (const group of request.groups) {
        options[group.label] = group.options.map(({ value, label, hint }) => ({
          value,
          label,
          hint,
        }));
      }

      const submitted = await clack.groupMultiselect({
        message: request.message,
        options,
        initialValues: [...request.initialValues],
        // Deselecting everything is a legitimate answer — setup reports "no
        // targets selected" rather than trapping the user in the picker.
        required: false,
        // Group headings are labels, not targets, so they must not be values.
        selectableGroups: false,
      });

      if (clack.isCancel(submitted)) return { cancelled: true };
      return { cancelled: false, value: submitted as string[] };
    },

    async serverUrl(): Promise<PromptResult<string>> {
      const answer = await clack.text({
        message:
          "Sync server URL (use the same URL as your first machine; leave blank for local-only)",
        placeholder: "https://sync.example.com",
        validate(value) {
          const url = value?.trim();
          return url ? validateServerUrl(url)?.stderr.trimEnd() : undefined;
        },
      });
      if (clack.isCancel(answer)) return { cancelled: true };
      return { cancelled: false, value: (answer as string).trim() };
    },

    async confirm(request: {
      message: string;
    }): Promise<PromptResult<boolean>> {
      // Accepting the default is the common answer on both call sites — setting
      // up the detected targets, taking the offered update — so Enter means yes.
      const answer = await clack.confirm({
        message: request.message,
        initialValue: true,
      });
      if (clack.isCancel(answer)) return { cancelled: true };
      return { cancelled: false, value: answer as boolean };
    },

    note(message: string, title: string): void {
      clack.note(message, title);
    },

    warn(message: string): void {
      clack.warn(message);
    },
  };
}
