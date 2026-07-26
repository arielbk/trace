import * as SwitchPrimitive from "@radix-ui/react-switch";
import { cn } from "../../lib/utils.ts";

/**
 * The board's toggle switch. Thin over Radix, but it owns the track and thumb
 * styling — including the checked-state geometry, which has to agree between
 * the two elements — so a second switch cannot quietly look different from the
 * first.
 */
export function Switch({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        "relative inline-flex h-5 w-switch shrink-0 items-center rounded-full border border-border bg-chip-bg px-0.5 data-[state=checked]:border-transparent data-[state=checked]:bg-accent",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="pointer-events-none block h-3.5 w-3.5 rounded-full bg-text-muted transition-transform data-[state=checked]:translate-x-4 data-[state=checked]:bg-white data-[state=unchecked]:translate-x-0" />
    </SwitchPrimitive.Root>
  );
}
