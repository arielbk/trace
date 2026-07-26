import * as PopoverPrimitive from "@radix-ui/react-popover";
import { createContext, useContext, type ReactNode } from "react";
import { cn } from "../../lib/utils.ts";
import { useDropdownTransition } from "./useDropdownTransition.ts";

/**
 * The board's dropdown: a Radix popover already wearing the `.t-dropdown`
 * open/close animation, the surface styling, and the force-mount plumbing that
 * animation needs.
 *
 * Consumers get `Dropdown` / `DropdownTrigger` / `DropdownContent` and never
 * touch `@radix-ui/react-popover` themselves. That is the point: the exit
 * transition needs `forceMount` on both the portal and the content, an
 * `.is-closing` class, and a timer that outlives Radix's own unmount — three
 * details that were previously copied into every popover and had already
 * drifted apart once. Restyling or re-timing every dropdown on the board is now
 * an edit to this file.
 *
 * The open state is deliberately internal. A dropdown that closes on selection
 * gets `close` from the content's render-prop form rather than by lifting state
 * into the caller, because a caller holding `open` would also have to reproduce
 * the closing delay for the animation to survive.
 */

/** Corner the dropdown scales out of; should match where the trigger sits. */
type DropdownOrigin =
  | "top-left"
  | "top-center"
  | "top-right"
  | "bottom-left"
  | "bottom-center"
  | "bottom-right";

interface DropdownState {
  isClosing: boolean;
  mounted: boolean;
  close: () => void;
}

const DropdownContext = createContext<DropdownState | null>(null);

function useDropdownContext(component: string): DropdownState {
  const state = useContext(DropdownContext);
  if (!state) {
    throw new Error(`<${component}> must be rendered inside a <Dropdown>`);
  }
  return state;
}

export function Dropdown({ children }: { children: ReactNode }) {
  const { open, isClosing, onOpenChange, mounted } = useDropdownTransition();

  return (
    <DropdownContext.Provider
      value={{ isClosing, mounted, close: () => onOpenChange(false) }}
    >
      <PopoverPrimitive.Root open={open} onOpenChange={onOpenChange}>
        {children}
      </PopoverPrimitive.Root>
    </DropdownContext.Provider>
  );
}

export function DropdownTrigger({
  className,
  children,
  ...props
}: React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Trigger>) {
  return (
    <PopoverPrimitive.Trigger className={className} {...props}>
      {children}
    </PopoverPrimitive.Trigger>
  );
}

export function DropdownContent({
  origin = "top-left",
  align = "start",
  sideOffset = 4,
  className,
  children,
  ...props
}: {
  origin?: DropdownOrigin;
  children: ReactNode | ((state: { close: () => void }) => ReactNode);
} & Omit<
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>,
  "forceMount" | "children"
>) {
  const { isClosing, mounted, close } = useDropdownContext("DropdownContent");
  if (!mounted) return null;

  return (
    <PopoverPrimitive.Portal forceMount>
      <PopoverPrimitive.Content
        forceMount
        data-origin={origin}
        align={align}
        sideOffset={sideOffset}
        className={cn(
          "t-dropdown z-50 rounded-md border border-border-subtle bg-surface shadow-md",
          isClosing && "is-closing",
          className,
        )}
        {...props}
      >
        {typeof children === "function" ? children({ close }) : children}
      </PopoverPrimitive.Content>
    </PopoverPrimitive.Portal>
  );
}
