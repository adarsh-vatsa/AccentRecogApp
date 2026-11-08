import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";

const cfg = loadConfig();
const app = createApp(cfg);
await app.listen();

console.log(`Dynamic Chats is running.
  App:    ${cfg.platformOrigin}
  Houses: ${cfg.houseScheme}://<house>.${cfg.houseDomain}
  Data:   ${cfg.dataDir}
  Builder model: ${cfg.agent.model}${process.env.ANTHROPIC_API_KEY ? "" : " (ANTHROPIC_API_KEY is not set, so builds will fail until it is)"}`);

// A stray rejected promise in one request must not take every house down. (Uncaught
// exceptions still exit: state may be corrupt, and a supervisor should restart us.)
process.on("unhandledRejection", (err) => console.error("[unhandledRejection]", err));

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    await app.close();
    process.exit(0);
  });
}
