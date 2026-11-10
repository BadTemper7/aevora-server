import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { mongodbAdapter } from "better-auth/adapters/mongodb";
import { username } from "better-auth/plugins";
import { MongoClient } from "mongodb";

import { env } from "../config/env.js";

/**
 * Build the auth instance. `database` is injectable so tests can use an in-memory store;
 * by default users, sessions and accounts live in your MongoDB.
 */
export function createAuth({ database } = {}) {
  if (!database) {
    const client = new MongoClient(env.MONGODB_URI);
    database = mongodbAdapter(client.db(), { client });
  }

  const googleEnabled = Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);

  return betterAuth({
    appName: "Aevora",
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    trustedOrigins: [env.CLIENT_URL],
    database,

    emailAndPassword: { enabled: true, minPasswordLength: 8, maxPasswordLength: 128, autoSignIn: true },

    socialProviders: googleEnabled
      ? { google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET } }
      : {},

    // links Google to an existing password account with the same (verified) email
    account: { accountLinking: { enabled: true, trustedProviders: ["google"] } },

    plugins: [username({ minUsernameLength: 3, maxUsernameLength: 20, immutableUsername: true, usernameValidator: (value) => /^[a-zA-Z0-9_]+$/.test(value) })],

    user: {
      additionalFields: {
        // input: false = a client can never set its own role
        role: { type: "string", defaultValue: "user", input: false },
      },
    },

    // same password rule as the client form: at least one letter and one number
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== "/sign-up/email") return;
        const password = ctx.body?.password ?? "";
        if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) {
          throw new APIError("BAD_REQUEST", { message: "Include at least one letter and one number." });
        }
      }),
    },
  });
}
