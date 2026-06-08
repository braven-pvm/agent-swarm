import test from "node:test";
import assert from "node:assert/strict";
import { greet, greetExcited } from "../src/greeter.js";

test("greets the provided name", () => {
  assert.equal(greet("Marius"), "Hello, Marius!");
});

test("greets the provided name excitedly", () => {
  assert.equal(greetExcited("Marius"), "Hello, Marius!!!");
});
