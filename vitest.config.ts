import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Repo root, with trailing slash (fileURLToPath of a dir URL keeps it).
const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      // `lib/server/**` modules guard themselves with `import "server-only"`,
      // which throws outside a React Server Component. Stub it so the kernel
      // modules can be unit-tested in a plain Node context.
      {
        find: /^server-only$/,
        replacement: fileURLToPath(
          new URL("./test/stubs/server-only.ts", import.meta.url),
        ),
      },
      // Mirror the `@/*` -> repo-root path alias from tsconfig.json.
      { find: /^@\//, replacement: root },
    ],
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
