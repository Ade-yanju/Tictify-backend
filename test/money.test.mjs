import { test } from "node:test";
import assert from "node:assert/strict";
import { computeFees } from "../src/controllers/payment.controller.js";
import { transferFee } from "../src/services/paystack.service.js";

test("computeFees: ₦5,000 ticket → guest pays 5,408, organizer gets 5,000", () => {
  const f = computeFees(5000);
  assert.equal(f.platformFee, 230);      // 3% + 80
  assert.equal(f.processingFee, 178);    // 1.5% of 5,230 + 100
  assert.equal(f.total, 5408);
});

test("computeFees: under ₦2,500 waives the ₦100 processing flat fee", () => {
  const f = computeFees(1000);
  assert.equal(f.platformFee, 110);
  assert.equal(f.processingFee, 17);     // 1.5% of 1,110, no +100
  assert.equal(f.total, 1127);
});

test("computeFees: processing fee caps at ₦2,000", () => {
  const f = computeFees(1_000_000);
  assert.equal(f.processingFee, 2000);
});

test("withdrawal fee: flat ₦100 (₦50 stamp duty + ₦50 platform)", () => {
  assert.equal(transferFee(500), 100);
  assert.equal(transferFee(25000), 100);
  assert.equal(transferFee(5000000), 100);
  // the user's own example: withdraw 25,000 → bank gets 24,900
  assert.equal(25000 - transferFee(25000), 24900);
});

test("order fees: 3 × ₦5,000 in one order is cheaper than 3 separate orders", () => {
  const oneOrder = computeFees(15000).total - 15000;
  const threeOrders = 3 * (computeFees(5000).total - 5000);
  assert.ok(oneOrder < threeOrders);
});
