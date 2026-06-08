import test from "node:test";
import assert from "node:assert/strict";
import { getDashboardModel } from "../src/dashboard.js";

test("returns baseline dashboard model", () => {
  assert.deepEqual(getDashboardModel(), {
    title: "Invoice dashboard",
  });
});
