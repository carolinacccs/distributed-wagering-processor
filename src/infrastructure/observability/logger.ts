import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: "distributed-wagering-processor" },
  redact: {
    paths: ["req.headers.authorization", "req.headers.cookie"],
    remove: true,
  },
});
