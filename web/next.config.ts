import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // `pg` is only used for local development against a plain Postgres (see
  // scripts/local-db.mjs). It resolves some of its internals with dynamic
  // requires, which break when bundled, so leave it as a runtime require.
  // Production uses the Neon HTTP driver and never loads this.
  serverExternalPackages: ["pg"],
};

export default nextConfig;
