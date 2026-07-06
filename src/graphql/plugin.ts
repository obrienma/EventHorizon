import type { FastifyInstance } from "fastify";
import { ApolloServer } from "@apollo/server";
import fastifyApollo, { fastifyApolloDrainPlugin } from "@as-integrations/fastify";
import { typeDefs } from "./schema.js";
import { resolvers } from "./resolvers.js";

export async function registerGraphQL(app: FastifyInstance): Promise<void> {
  const apollo = new ApolloServer({
    typeDefs,
    resolvers,
    plugins: [fastifyApolloDrainPlugin(app)],
  });

  await apollo.start();
  await app.register(fastifyApollo(apollo));

  console.log("[graphql] server registered at /graphql");
}
