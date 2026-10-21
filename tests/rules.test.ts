import { test } from "node:test";
import assert from "node:assert/strict";

import { buildRuleSet, classify, globToRegExp, isNeverSynced, parseList, pluginIdOf } from "../src/core/rules";
import { defaultSettings } from "../src/core/types";

test("workspace 与本插件数据永不参与同步", () => {
	assert.equal(isNeverSynced("workspace.json"), true);
	assert.equal(isNeverSynced("workspace-mobile.json"), true);
	assert.equal(isNeverSynced("plugins/configsync-hub/data.json"), true);
	assert.equal(isNeverSynced("configsync-hub/state.json"), true);
	assert.equal(isNeverSynced("configsync-hub-backups/x.zip"), true);
	assert.equal(isNeverSynced("plugins/dataview/main.js"), false);
});

test("路径分类", () => {
	assert.equal(classify("plugins/dataview/main.js"), "plugins");
	assert.equal(classify("plugins/dataview/data.json"), "pluginData");
	assert.equal(classify("themes/foo/theme.css"), "themes");
	assert.equal(classify("snippets/a.css"), "snippets");
	assert.equal(classify("appearance.json"), "appearance");
	assert.equal(classify("community-plugins.json"), "communityPlugins");
	assert.equal(classify("core-plugins.json"), "corePlugins");
	assert.equal(classify("hotkeys.json"), "hotkeys");
	assert.equal(classify("app.json"), "appSettings");
	assert.equal(classify("graph.json"), "graph");
	assert.equal(classify("daily-notes.json"), "corePluginData");
	assert.equal(classify("plugins/configsync-hub/data.json"), null);
	assert.equal(classify("random/unknown.txt"), null);
});

test("通配符规则", () => {
	assert.equal(globToRegExp("plugins/*/data.json").test("plugins/foo/data.json"), true);
	assert.equal(globToRegExp("plugins/*/data.json").test("plugins/foo/main.js"), false);
	assert.equal(globToRegExp("themes/**").test("themes/a/b.css"), true);
	assert.equal(globToRegExp("**/*.css").test("snippets/x.css"), true);
	assert.equal(globToRegExp("**/*.css").test("snippets/x.txt"), false);
});

test("规则集：分类开关与排除规则均生效", () => {
	const s = defaultSettings();
	assert.equal(buildRuleSet(s).isSynced("plugins/dataview/data.json"), true);

	s.categories.pluginData = false;
	assert.equal(buildRuleSet(s).isSynced("plugins/dataview/data.json"), false);
	assert.equal(buildRuleSet(s).isSynced("plugins/dataview/main.js"), true);

	s.categories.pluginData = true;
	s.excludedPlugins = ["dataview"];
	assert.equal(buildRuleSet(s).isSynced("plugins/dataview/main.js"), false);
	assert.equal(buildRuleSet(s).isSynced("plugins/templater/main.js"), true);

	s.excludedPlugins = [];
	s.excludedPaths = ["plugins/*/data.json"];
	assert.equal(buildRuleSet(s).isSynced("plugins/templater/data.json"), false);

	assert.equal(buildRuleSet(s).excludedBy("workspace.json"), "never");
});

test("插件 id 提取与列表解析", () => {
	assert.equal(pluginIdOf("plugins/dataview/main.js"), "dataview");
	assert.equal(pluginIdOf("themes/x.css"), null);
	assert.deepEqual(parseList("a, b\nc;;\n"), ["a", "b", "c"]);
});
