import pino from "pino";

const usePrettyLogs = !process.env.VERCEL && process.env.NODE_ENV !== "production";

export const logger = pino({
  level: "info",
  ...(usePrettyLogs ? { transport: { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:standard" } } } : {})
});
