/**
 * 日志重定向
 *
 * 把 stdout 同时写到 logs/server.log，方便排查。
 */

import { createWriteStream, mkdirSync, existsSync } from "node:fs";
import path from "node:path";

const LOGS_DIR = path.resolve(process.cwd(), "logs");
const SERVER_LOG = path.join(LOGS_DIR, "server.log");

export function enableFileLogging(): void {
  if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });

  const fileStream = createWriteStream(SERVER_LOG, { flags: "a" });

  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);

  function makeWrite(original: typeof originalStdoutWrite) {
    return function (
      chunk: Uint8Array | string,
      encoding?: BufferEncoding | ((err?: Error) => void),
      callback?: (err?: Error) => void,
    ): boolean {
      const str = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      fileStream.write(str);
      return original(chunk, encoding as BufferEncoding, callback as ((err?: Error | null) => void) | undefined);
    };
  }

  process.stdout.write = makeWrite(originalStdoutWrite) as typeof process.stdout.write;
  process.stderr.write = makeWrite(originalStderrWrite) as typeof process.stderr.write;

  process.on("exit", () => fileStream.end());
  process.on("SIGINT", () => fileStream.end());
  process.on("SIGTERM", () => fileStream.end());
}
