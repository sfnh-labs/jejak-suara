import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({ baseDirectory: __dirname });

const eslintConfig = [
  // `next lint` skipped build output implicitly; the ESLint CLI does not, and
  // would otherwise report thousands of errors from bundled vendor code.
  {
    ignores: [
      ".next/**",
      ".open-next/**",
      ".wrangler/**",
      "next-env.d.ts",
      "cloudflare-env.d.ts",
    ],
  },
  ...compat.extends("next/core-web-vitals"),
];

export default eslintConfig;
