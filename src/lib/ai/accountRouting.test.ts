import assert from "node:assert/strict";
import test from "node:test";
import {
  isNotificationOrSubscriptionRequest,
  shouldAskForTransactionAccount,
  shouldClassifyAsDirectTransaction,
} from "./accountRouting";

test("subscription reminders do not require a transaction account", () => {
  const shouldAsk = shouldAskForTransactionAccount({
    message: "tambahkan langganan icoud 59rb setiap bulan",
    classification: {
      isTransaction: true,
      needsAccount: true,
    },
    accountCount: 2,
    isBalanceAdjustment: false,
  });

  assert.equal(shouldAsk, false);
});

test("ordinary transactions without an account still require one", () => {
  const shouldAsk = shouldAskForTransactionAccount({
    message: "makan siang 50rb",
    classification: {
      isTransaction: true,
      needsAccount: true,
    },
    accountCount: 2,
    isBalanceAdjustment: false,
  });

  assert.equal(shouldAsk, true);
});

test("subscription commands bypass the direct transaction classifier", () => {
  assert.equal(
    shouldClassifyAsDirectTransaction(
      "tambahkan langganan icoud 59rb setiap bulan",
    ),
    false,
  );
  assert.equal(shouldClassifyAsDirectTransaction("makan siang 50rb"), true);
});

test("subscription queries are not mistaken for subscription commands", () => {
  assert.equal(
    isNotificationOrSubscriptionRequest("apa saja paket langganan saya"),
    false,
  );
  assert.equal(
    isNotificationOrSubscriptionRequest("berapa pengeluaran bulanan saya"),
    false,
  );
  assert.equal(
    isNotificationOrSubscriptionRequest("daftar tagihan bulanan saya"),
    false,
  );
  assert.equal(
    isNotificationOrSubscriptionRequest("buat langganan iCloud 59rb"),
    true,
  );
});
