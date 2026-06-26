import app from "./app";
import { logger } from "./lib/logger";
import { startPoller } from "./lib/poller";
import { randomBytes } from "crypto";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

if (!process.env.SETTINGS_ENCRYPTION_KEY) {
  const generated = randomBytes(32).toString("hex");
  process.env.SETTINGS_ENCRYPTION_KEY = generated;
  logger.warn(
    "SETTINGS_ENCRYPTION_KEY is not set. A random session key was generated — " +
    "encrypted settings (Printavo API key) will not persist across server restarts. " +
    "Set SETTINGS_ENCRYPTION_KEY as a Replit secret to persist them. " +
    "Generate a value with: openssl rand -hex 32"
  );
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  startPoller().catch(pollerErr => {
    logger.warn({ err: pollerErr }, "Printavo poller failed to start (non-fatal)");
  });
});
