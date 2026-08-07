import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// No incremental cache configured: every route that reads Neon is
// force-dynamic, so there is nothing to revalidate or store.
export default defineCloudflareConfig();
