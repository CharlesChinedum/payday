import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/** Resolves the `@/` imports the app uses, so route handlers can be tested directly. */
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
});
