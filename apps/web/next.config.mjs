/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The repo lints with a single root ESLint flat config (`eslint .`), so skip Next's own
  // lint-during-build to avoid a second, conflicting lint setup. Type-checking stays on.
  eslint: { ignoreDuringBuilds: true },
  // The web app shares the relay's persistence layer (docs/DECISIONS.md D6); transpile that
  // workspace package and keep its native/server-only deps external (not bundled by Next).
  transpilePackages: ["@designbridge/app-relay"],
  serverExternalPackages: ["pg", "ws", "fastify", "@fastify/websocket"],
  // The monorepo uses NodeNext-style `.js` import specifiers that point at `.ts` sources. Teach
  // webpack the same mapping (mirrors tsc moduleResolution + how vitest already resolves) so we
  // keep one import convention across the whole repo.
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
      ".jsx": [".tsx", ".jsx"],
      ".mjs": [".mts", ".mjs"],
    };
    return config;
  },
};

export default nextConfig;
