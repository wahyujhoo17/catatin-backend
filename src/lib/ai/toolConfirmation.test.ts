import assert from "node:assert/strict";
import test from "node:test";
import { assessToolConfirmation } from "./toolConfirmation";

test("an explicit write action cannot claim confirmation without a tool call", () => {
  const modelText =
    "Saya sudah menyiapkan penyesuaian saldo akun BRI menjadi Rp1.000.000. Mohon periksa kembali rinciannya sebelum dikonfirmasi.";
  const assessment = assessToolConfirmation({
    actionMode: true,
    toolCallCount: 0,
    modelText,
  });

  assert.equal(assessment.needsRequiredToolRetry, true);
  assert.notEqual(assessment.safeText, modelText);
});

test("normal chat text remains valid without tool calls", () => {
  const modelText = "Saldo BRI Anda saat ini Rp500.000.";
  const assessment = assessToolConfirmation({
    actionMode: false,
    toolCallCount: 0,
    modelText,
  });

  assert.equal(assessment.needsRequiredToolRetry, false);
  assert.equal(assessment.safeText, modelText);
});

test("an action response with a tool call does not need a retry", () => {
  const assessment = assessToolConfirmation({
    actionMode: true,
    toolCallCount: 1,
    modelText: "",
  });

  assert.equal(assessment.needsRequiredToolRetry, false);
});
