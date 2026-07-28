import assert from "node:assert/strict";
import test from "node:test";
import { syncChatRequestSchema } from "./requestSchemas";

test("receipt scanner accepts its boolean draft payload", () => {
  const result = syncChatRequestSchema.safeParse({
    message: "Tolong analisis struk ini.",
    image: "data:image/jpeg;base64,AA==",
    draft: true,
  });

  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.data.draft, true);
  }
});

test("receipt scanner still rejects unsupported image data URLs", () => {
  const result = syncChatRequestSchema.safeParse({
    message: "Tolong analisis struk ini.",
    image: "data:image/svg+xml;base64,PHN2Zz4=",
    draft: true,
  });

  assert.equal(result.success, false);
});
