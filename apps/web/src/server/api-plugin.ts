import type { Plugin } from "vite";
import { getTaskTimeline, listTasks } from "./data.ts";

export function traceApiPlugin(): Plugin {
  return {
    name: "trace-api",
    configureServer(server) {
      server.middlewares.use("/api/tasks", (req, res, next) => {
        try {
          const url = req.url ?? "/";
          if (url === "/" || url === "") {
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify(listTasks()));
            return;
          }
          const match = /^\/([^/]+)\/timeline\/?$/.exec(url);
          if (match && match[1]) {
            const timeline = getTaskTimeline(match[1]);
            if (!timeline) {
              res.statusCode = 404;
              res.end();
              return;
            }
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify(timeline));
            return;
          }
          next();
        } catch (err) {
          res.statusCode = 500;
          res.end(String(err));
        }
      });
    },
  };
}
