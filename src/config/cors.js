import { env } from "./env.js";

// credentials: true lets the browser send the session cookie
export const corsOptions = {
  origin: env.CLIENT_URL,
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization"],
};
