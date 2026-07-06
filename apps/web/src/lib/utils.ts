import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// index.css's `@theme` adds project-specific font-size tokens (crumb, chip,
// row-time, etc.) that tailwind-merge doesn't recognize out of the box.
// Unregistered, twMerge misclassifies e.g. `text-crumb` as a text-*color*
// utility and silently drops it whenever a real text-color class (like
// `text-text-muted`) appears later in the same conditional class list.
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [
        {
          text: [
            "badge",
            "chip",
            "crumb",
            "meta",
            "caption",
            "row-time",
            "row-title",
            "page-title",
          ],
        },
      ],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
