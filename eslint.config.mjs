/**
 * ESLint flat config：对齐 Obsidian 社区插件市场的自动审核
 * （community.obsidian.md 提交后跑的就是 eslint-plugin-obsidianmd 这套规则）。
 *
 * 运行：npm run lint
 */

import tsparser from "@typescript-eslint/parser";
import tsplugin from "@typescript-eslint/eslint-plugin";
import obsidianmd from "eslint-plugin-obsidianmd";

export default [
	{
		ignores: ["node_modules/**", "main.js", ".tmp-test/**", "dist/**"],
	},

	// 注册官方插件并启用 recommended 全套规则（与线上审核一致）
	{
		plugins: { obsidianmd },
		rules: obsidianmd.configs.recommended,
	},

	// 与审核环境对齐：源码里的 require() 走 @typescript-eslint/no-var-requires，
	// 均带 `-- 说明` 的 disable 注释；any 一律禁止
	{
		plugins: { "@typescript-eslint": tsplugin },
		rules: {
			"@typescript-eslint/no-var-requires": "error",
			"@typescript-eslint/no-explicit-any": "error",
		},
	},

	// TS 源码用 @typescript-eslint/parser 解析（obsidianmd 部分规则需要类型信息）
	{
		files: ["**/*.ts"],
		languageOptions: {
			parser: tsparser,
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
	},
];
