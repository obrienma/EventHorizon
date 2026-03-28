import type { FastifyInstance } from "fastify";
import { EventSchema } from "./event.schema.js";
import { publishEvent } from "../processing/queue.js";

export async function eventRoutes(app: FastifyInstance): Promise<void> {
  app.post("/events", async (request, reply) => {
    const result = EventSchema.safeParse(request.body);

    if (!result.success) {
      return reply.status(422).send({ errors: result.error.issues });
    }

    // TODO: publishEvent can throw if RabbitMQ is unavailable — what HTTP status
    // is appropriate here? Should the ingestion plane return 503, or let the
    // exception bubble up to Fastify's default 500 handler?
    publishEvent(result.data);

    return reply.status(202).send({ id: result.data.id });
  });
}
