import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      // Short staleTime so a glance at the board (refetchOnWindowFocus) reflects
      // out-of-process DB writes — binds, subagent discovery, hook updates —
      // instead of waiting out a multi-minute window.
      staleTime: 1000 * 3,
    },
    mutations: {
      retry: false,
    },
  },
});
