import "dotenv/config";
import type { Prisma } from "@prisma/client";
import prisma from "../lib/prisma";
import { encryptAiSecret } from "../lib/ai/secrets";

interface LegacyAiConfig {
  apiKey?: string;
  apiKeyEncrypted?: string;
  elevenLabsApiKey?: string;
  elevenLabsApiKeyEncrypted?: string;
  [key: string]: unknown;
}

async function migrateAiSecrets() {
  const users = await prisma.user.findMany({
    select: { id: true, customAiConfig: true },
  });
  let migrated = 0;

  for (const user of users) {
    const config = user.customAiConfig as LegacyAiConfig | null;
    if (!config) continue;
    const hasLegacyApiKey = Boolean(config.apiKey);
    const hasLegacyElevenLabsKey = Boolean(config.elevenLabsApiKey);
    if (!hasLegacyApiKey && !hasLegacyElevenLabsKey) continue;

    const {
      apiKey,
      elevenLabsApiKey,
      ...configWithoutPlaintextSecrets
    } = config;
    const securedConfig: LegacyAiConfig = {
      ...configWithoutPlaintextSecrets,
      apiKeyEncrypted:
        config.apiKeyEncrypted ||
        (apiKey ? encryptAiSecret(apiKey) : undefined),
      elevenLabsApiKeyEncrypted:
        config.elevenLabsApiKeyEncrypted ||
        (elevenLabsApiKey
          ? encryptAiSecret(elevenLabsApiKey)
          : undefined),
    };

    await prisma.user.update({
      where: { id: user.id },
      data: {
        customAiConfig: securedConfig as Prisma.InputJsonValue,
      },
    });
    migrated += 1;
  }

  console.log(
    `[Security] Migrasi secret AI selesai: ${migrated} user diperbarui.`,
  );
}

migrateAiSecrets()
  .catch((error: unknown) => {
    console.error(
      "[Security] Migrasi secret AI gagal:",
      error instanceof Error ? error.message : "Unknown error",
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
