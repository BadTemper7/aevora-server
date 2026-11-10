// End-to-end auth flow against an in-memory store (no MongoDB needed).
process.env.BETTER_AUTH_SECRET = "x".repeat(40);
process.env.BETTER_AUTH_URL = "http://localhost:5173";
process.env.CLIENT_URL = "http://localhost:5173";

import assert from "node:assert/strict";
import { test } from "node:test";
import { memoryAdapter } from "better-auth/adapters/memory";
import request from "supertest";

const { createAuth } = await import("../src/lib/auth.js");
const { createApp } = await import("../src/app.js");

const store = { user: [], session: [], account: [], verification: [] };
const auth = createAuth({ database: memoryAdapter(store) });
const app = createApp(auth);

const ORIGIN = "http://localhost:5173";
const person = { name: "Rey Santos", username: "reysantos", email: "rey@example.com", password: "Passw0rdOK" };
const agent = request.agent(app);

test("health", async () => {
  assert.equal((await request(app).get("/api/health")).status, 200);
});

test("protected route is closed without a session", async () => {
  const res = await request(app).get("/api/me");
  assert.equal(res.status, 401);
  assert.equal(res.body.error.code, "UNAUTHENTICATED");
});

test("weak password is rejected", async () => {
  const res = await request(app).post("/api/auth/sign-up/email").set("Origin", ORIGIN)
    .send({ ...person, email: "weak@example.com", username: "weakone", password: "onlyletters" });
  assert.equal(res.status, 400);
});

test("register creates the user and signs them in", async () => {
  const res = await agent.post("/api/auth/sign-up/email").set("Origin", ORIGIN).send(person);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.user.email, person.email);
  assert.equal(store.user.length, 1);
  assert.equal(store.account.length, 1);
  assert.notEqual(store.account[0].password, person.password); // stored hashed
});

test("username availability is checked before creating a user (case-insensitive)", async () => {
  const initialUsers = store.user.length;

  const taken = await request(app)
    .post("/api/auth/is-username-available")
    .set("Origin", ORIGIN)
    .send({ username: "REYSANTOS" });
  assert.equal(taken.status, 200, JSON.stringify(taken.body));
  assert.equal(taken.body.available, false);

  const free = await request(app)
    .post("/api/auth/is-username-available")
    .set("Origin", ORIGIN)
    .send({ username: "brand_new_name" });
  assert.equal(free.status, 200, JSON.stringify(free.body));
  assert.equal(free.body.available, true);

  // Availability requests never create a registration record.
  assert.equal(store.user.length, initialUsers);
});

test("session cookie opens the protected route", async () => {
  const res = await agent.get("/api/me");
  assert.equal(res.status, 200);
  assert.equal(res.body.data.user.username, "reysantos");
  assert.equal(res.body.data.user.role, "user");
});

test("duplicate email is rejected", async () => {
  const res = await request(app).post("/api/auth/sign-up/email").set("Origin", ORIGIN)
    .send({ ...person, username: "someoneelse" });
  assert.ok(res.status >= 400 && res.status < 500);
  assert.equal(store.user.length, 1);
});

test("a client cannot grant itself admin", async () => {
  const res = await request(app).post("/api/auth/sign-up/email").set("Origin", ORIGIN)
    .send({ name: "Sneaky", username: "sneaky", email: "sneaky@example.com", password: "Passw0rdOK", role: "admin" });
  assert.equal(store.user.find((u) => u.email === "sneaky@example.com")?.role, "user", JSON.stringify(res.body));
});

test("role gate: a normal user gets 403 on the admin route", async () => {
  assert.equal((await agent.get("/api/admin/ping")).status, 403);
});

test("role gate: an admin gets through", async () => {
  store.user.find((u) => u.email === person.email).role = "admin";
  assert.equal((await agent.get("/api/admin/ping")).status, 200);
});

test("sign out closes the door, sign in reopens it", async () => {
  await agent.post("/api/auth/sign-out").set("Origin", ORIGIN).send({});
  assert.equal((await agent.get("/api/me")).status, 401);

  const bad = await request(app).post("/api/auth/sign-in/email").set("Origin", ORIGIN).send({ email: person.email, password: "wrongpass1" });
  assert.equal(bad.status, 401);

  const ok = await agent.post("/api/auth/sign-in/email").set("Origin", ORIGIN).send({ email: person.email, password: person.password });
  assert.equal(ok.status, 200);
  assert.equal((await agent.get("/api/me")).status, 200);
});

test("google sign-in is off without credentials", async () => {
  const res = await request(app).post("/api/auth/sign-in/social").set("Origin", ORIGIN).send({ provider: "google" });
  assert.ok(res.status >= 400);
});

test("incomplete Google-style profile cannot access app until username chosen", async () => {
  const user = store.user.find((u) => u.email === person.email);
  const original = user.username;
  user.username = null;
  assert.equal((await agent.get("/api/me")).status, 403);

  const updated = await agent.post("/api/auth/update-user").set("Origin", ORIGIN)
    .send({ username: "chosen_name" });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  assert.equal(store.user.find((u) => u.email === person.email).username, "chosen_name");
  assert.equal((await agent.get("/api/me")).status, 200);
  user.username = original;
});

test("username collision is rejected (case-insensitive)", async () => {
  const response = await request(app).post("/api/auth/sign-up/email").set("Origin", ORIGIN)
    .send({ name: "Another Person", email: "another@example.com", username: "REYSANTOS", password: "Passw0rdOK" });
  assert.ok(response.status >= 400 && response.status < 500, JSON.stringify(response.body));
});
