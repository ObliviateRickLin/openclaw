// Covers the in-process restart boundary: cached plugin registries must drop so
// updated workspace plugin source on disk loads on the next startup (#103571).
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { clearPluginCachesForInProcessRestart, loadOpenClawPlugins } from "./loader.js";
import {
  cleanupPluginLoaderFixturesForTest,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "./loader.test-fixtures.js";

afterEach(() => {
  resetPluginLoaderTestStateForTest();
});

afterAll(() => {
  cleanupPluginLoaderFixturesForTest();
});

function pluginBody(toolName: string): string {
  return `module.exports = {
  id: "restart-reload-probe",
  register(api) {
    api.registerTool({
      name: ${JSON.stringify(toolName)},
      description: "restart reload probe tool",
      parameters: {},
      execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
    });
  },
};`;
}

function writeManifest(dir: string, toolName: string): void {
  fs.writeFileSync(
    path.join(dir, "openclaw.plugin.json"),
    JSON.stringify(
      {
        id: "restart-reload-probe",
        configSchema: { type: "object", additionalProperties: false },
        contracts: { tools: [toolName] },
      },
      null,
      2,
    ),
    "utf-8",
  );
}

function loadedToolNames(registry: ReturnType<typeof loadOpenClawPlugins>): string[] {
  return registry.tools.flatMap((entry) => entry.names);
}

describe("plugin loader in-process restart reload", () => {
  it("loads updated workspace plugin code after the restart-boundary cache clear (#103571)", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "restart-reload-probe",
      filename: "restart-reload-probe.cjs",
      body: pluginBody("probe_tool_v1"),
    });
    writeManifest(plugin.dir, "probe_tool_v1");
    const config = {
      plugins: {
        load: { paths: [plugin.dir] },
        allow: ["restart-reload-probe"],
      },
    };

    const first = loadOpenClawPlugins({ config });
    expect(loadedToolNames(first)).toContain("probe_tool_v1");

    // Update the plugin source (and its declared tool contract) on disk — the
    // issue's repro step 3: add a tool, expect it after an in-process restart.
    fs.writeFileSync(plugin.file, pluginBody("probe_tool_v2"), "utf-8");
    writeManifest(plugin.dir, "probe_tool_v2");

    // Without the restart-boundary clear the cached registry re-serves the old
    // module graph — the stale behavior reported for in-process restarts.
    const stale = loadOpenClawPlugins({ config });
    expect(loadedToolNames(stale)).toContain("probe_tool_v1");
    expect(loadedToolNames(stale)).not.toContain("probe_tool_v2");

    // The in-process restart boundary drops plugin caches, so the next startup
    // loads the updated source from disk.
    clearPluginCachesForInProcessRestart();
    const reloaded = loadOpenClawPlugins({ config });
    expect(loadedToolNames(reloaded)).toContain("probe_tool_v2");
    expect(loadedToolNames(reloaded)).not.toContain("probe_tool_v1");
  });
});
