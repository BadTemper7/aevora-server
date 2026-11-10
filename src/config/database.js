import mongoose from "mongoose";

import { env } from "./env.js";

export async function connectDatabase() {
  mongoose.set("strictQuery", true);
  await mongoose.connect(env.MONGODB_URI);
  // Null/missing usernames are allowed while a Google registration is in progress.
  // Database-level uniqueness is the final defense against concurrent submissions.
  await mongoose.connection.db.collection("user").createIndex(
    { username: 1 },
    { unique: true, partialFilterExpression: { username: { $type: "string" } }, name: "aevora_unique_username" },
  );
  console.log("MongoDB connected; username uniqueness index ready");
}
