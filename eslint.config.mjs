import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    // dev 与 build 的产物目录已隔离（见 next.config.ts），否则 `npm run lint`
    // 会把 Turbopack 生成的 .next-dev 编译产物一起扫进去，报出上千条无关错误。
    ".next-dev/**",
    ".next-prod/**",
    ".next-smoke/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
