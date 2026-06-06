import { Context } from "hono";

export async function errorMiddleware(err: Error, c: Context) {
  console.error("[ERROR]", err);
  return c.json(
    {
      error: "Internal Server Error",
      message: process.env.NODE_ENV === "development" ? err.message : undefined,
    },
    500,
  );
}
