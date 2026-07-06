import type { FastifyInstance } from "fastify";
import { ApolloServer } from "@apollo/server";
import fastifyApollo, {
  fastifyApolloDrainPlugin,
  type ApolloFastifyContextFunction,
} from "@as-integrations/fastify";
import { typeDefs } from "./schema.js";
import { resolvers } from "./resolvers.js";
import { createPipelineStepsLoader, type GraphQLContext } from "./loaders.js";

// A fresh DataLoader per request — a shared/global instance would cache
// (and leak) results across unrelated requests indefinitely.
const context: ApolloFastifyContextFunction<GraphQLContext> = async () => ({
  pipelineStepsLoader: createPipelineStepsLoader(),
});

export async function registerGraphQL(app: FastifyInstance): Promise<void> {
  const apollo = new ApolloServer<GraphQLContext>({
    typeDefs,
    resolvers,
    plugins: [fastifyApolloDrainPlugin(app)],
  });

  await apollo.start();
  await app.register(fastifyApollo(apollo), { context });

  console.log("[graphql] server registered at /graphql");
}
