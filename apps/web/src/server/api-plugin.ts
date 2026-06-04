import type { Plugin } from "vite";
import {
  archiveTask,
  getTaskTimeline,
  listTaskSummaries,
  unarchiveTask,
} from "./data.ts";

export function traceApiPlugin(): Plugin {
  return {
    name: "trace-api",
    configureServer(server) {
      server.middlewares.use("/api/tasks", (req, res, next) => {
        try {
          const url = req.url ?? "/";
          if (url === "/" || url === "") {
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify(listTaskSummaries()));
            return;
          }
          const archiveMatch = /^\/([^/]+)\/(archive|unarchive)\/?$/.exec(url);
          if (archiveMatch && archiveMatch[1] && archiveMatch[2]) {
            if (req.method !== "POST") {
              res.statusCode = 405;
              res.end();
              return;
            }
            const task =
              archiveMatch[2] === "archive"
                ? archiveTask(archiveMatch[1])
                : unarchiveTask(archiveMatch[1]);
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify(task));
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
          res.statusCode =
            err instanceof Error && err.message.startsWith("Task not found:")
              ? 404
              : 500;
          res.end(String(err));
        }
      });
    },
  };
}
