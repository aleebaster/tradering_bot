import express from "express";
import cors from "cors";
import { WebSocketServer } from "ws";
import { createServer } from "node:http";
import { config } from "./config";
import { state } from "./state";
import { Scanner } from "./scanner";
import { logger } from "./logger";
import { TelegramCommandCenter } from "./telegramCommands";

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

app.get("/health", (_req, res) => res.json({ ok: true, mode: config.mode, partialMode: config.partialMode, warnings: state.diagnostics.warnings }));
app.get("/state", (_req, res) => res.json(state));
app.get("/signals", (_req, res) => res.json({ active: state.activeSignals, watchlist: state.watchlist, history: state.history }));
app.get("/diagnostics", (_req, res) => res.json(state.diagnostics));

const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

function broadcast(payload: unknown) {
  const data = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(data);
  }
}

wss.on("connection", (socket) => socket.send(JSON.stringify({ type: "state", state })));

const scanner = new Scanner(broadcast);
const telegramCommands = new TelegramCommandCenter();
server.listen(config.LOCAL_API_PORT, () => {
  logger.info(`Локальний API слухає http://localhost:${config.LOCAL_API_PORT}`);
  if (config.warning) logger.warn(config.warning);
  telegramCommands.start();
  void scanner.start();
});

process.on("SIGINT", () => {
  telegramCommands.stop();
  scanner.stop();
  server.close(() => process.exit(0));
});
