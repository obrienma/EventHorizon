import Fastify from "fastify";
import { readFileSync } from "fs";
import { eventRoutes } from "./ingestion/event.routes.js";
import { registerWsServer } from "./observation/wsServer.js";

export const app = Fastify({ logger: true });

void app.register(eventRoutes);
await registerWsServer(app);

const dashboardHtml = readFileSync(new URL("./dashboard/index.html", import.meta.url));
const faviconIco   = readFileSync(new URL("./dashboard/favicon.ico", import.meta.url));
app.get("/dashboard", (_req, reply) => reply.type("text/html").send(dashboardHtml));
app.get("/favicon.ico", (_req, reply) => reply.type("image/x-icon").send(faviconIco));
