import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { PluginContext } from "../src/edgeever";
import { setHostLanguageOverride } from "../src/i18n";
import { generateDigestText, runCategoryDigestJob } from "../src/main";

const rss = () => `<?xml version="1.0"?><rss version="2.0"><channel><item><title>Engineering update</title><link>https://example.com/update</link><pubDate>${new Date().toUTCString()}</pubDate><description>Useful change</description></item></channel></rss>`;

const contextWith = (generate: PluginContext["ai"]["generate"], autoTranslate = false, saveSucceeds = false): PluginContext => ({
  ai: { status: async () => ({ configured: true }), generate },
  network: { fetch: async () => new Response(rss(), { status: 200 }) },
  storage: { get: async () => null, set: async () => undefined },
  notebooks: { list: async () => [{ id: "notebook", parentId: null, name: "Notes", memoCount: 0 }] },
  notes: {
    query: async () => ({ notes: [], totalCount: 0, nextOffset: null }),
    create: async () => {
      if (!saveSucceeds) throw new Error("disk is full");
      return { id: "created", notebookId: "notebook", title: "Digest", contentMarkdown: "Digest", tags: [] };
    },
    update: async () => { throw new Error("unused"); },
  },
  settings: { get: async (key: string) => key === "topics.engineering" ? true : key === "translation.auto-enabled" ? autoTranslate : null, set: async () => undefined, remove: async () => undefined },
} as unknown as PluginContext);

describe("digest job failures", () => {
  let errorLog: ReturnType<typeof spyOn>;
  beforeEach(() => {
    setHostLanguageOverride("zh-CN");
    errorLog = spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    setHostLanguageOverride(null);
    errorLog.mockRestore();
  });

  test("reports an AI error with its category and stage", async () => {
    const result = await runCategoryDigestJob(contextWith(async () => { throw new Error("model unavailable"); }));
    expect(result.failed).toBe(1);
    expect(result.failureDetails).toEqual(["开发与开源 · AI 生成：model unavailable"]);
  });

  test("reports a note write error separately from AI generation", async () => {
    const result = await runCategoryDigestJob(contextWith(async () => ({ text: "## 01 | Engineering update\n\n> 🔗 **信源**：〔1〕" })));
    expect(result.failed).toBe(1);
    expect(result.failureDetails).toEqual(["开发与开源 · 保存笔记：disk is full"]);
  });

  test("keeps translation requests within the host output token limit", async () => {
    const limits: number[] = [];
    await runCategoryDigestJob(contextWith(async (input) => {
      limits.push(input.maxOutputTokens ?? 0);
      return { text: limits.length === 1 ? "## 01 | Engineering update\n\n> 🔗 **信源**：〔1〕" : "[]" };
    }, true, true));
    expect(limits).toEqual([3_000, 1_500]);
  });

  test("retries once when the provider reports an affordable token ceiling", async () => {
    const limits: number[] = [];
    const context = contextWith(async (input) => {
      limits.push(input.maxOutputTokens ?? 0);
      if (limits.length === 1) throw new Error("can only afford 2200");
      return { text: "Digest" };
    });
    expect(await generateDigestText(context, "system", "prompt")).toBe("Digest");
    expect(limits).toEqual([3_000, 1_870]);
  });

  test("omits provider account URLs from the visible failure", async () => {
    const result = await runCategoryDigestJob(contextWith(async () => {
      throw new Error("Need credits: https://openrouter.ai/workspaces/default/keys/secret-id");
    }));
    expect(result.failureDetails[0]).toContain("[链接已省略]");
    expect(result.failureDetails[0]).not.toContain("secret-id");
  });
});

describe("digest job in an English interface", () => {
  let errorLog: ReturnType<typeof spyOn>;
  beforeEach(() => {
    setHostLanguageOverride("en-US");
    errorLog = spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    setHostLanguageOverride(null);
    errorLog.mockRestore();
  });

  test("reports failures in English with the English topic name", async () => {
    const result = await runCategoryDigestJob(contextWith(async () => {
      throw new Error("Need credits: https://openrouter.ai/workspaces/default/keys/secret-id");
    }));
    expect(result.failureDetails).toEqual(["Engineering and Open Source · AI generation: Need credits: [link omitted]"]);
  });

  test("asks the model for an English digest and saves an English note", async () => {
    const prompts: string[] = [];
    const saved: Array<{ title?: string; contentMarkdown?: string }> = [];
    const context = contextWith(async (input) => {
      prompts.push(input.system);
      return { text: "## 01 | Engineering update\n\n- **Key development**: Useful change.\n\n> 🔗 **Sources**: 〔1〕" };
    });
    context.notes.create = async (input) => {
      saved.push(input);
      return { id: "created", notebookId: "notebook", title: input.title ?? null, contentMarkdown: input.contentMarkdown ?? "", tags: [] };
    };
    const result = await runCategoryDigestJob(context);
    expect(result).toMatchObject({ created: 1, failed: 0 });
    expect(prompts[0]).toContain("Write the entire digest in English");
    expect(prompts[0]).not.toMatch(/[\u4e00-\u9fff]/);
    expect(saved[0]?.title).toMatch(/ · Engineering and Open Source · RSS Digest$/);
    expect(saved[0]?.contentMarkdown).toContain("**1 selected article** (last 24 hours)");
    expect(saved[0]?.contentMarkdown).toContain("> 🔗 **Sources**: [GitHub Changelog](<https://example.com/update>) · [Also covered · ");
    expect(saved[0]?.contentMarkdown).not.toMatch(/[\u4e00-\u9fff]/);
  });

  test("keeps an explicit Chinese target in an English interface", async () => {
    const prompts: string[] = [];
    const context = contextWith(async (input) => {
      prompts.push(input.system);
      throw new Error("stop");
    });
    const get = context.settings.get;
    context.settings.get = async (key: string) => key === "translation.target-language" ? "zh-CN" : get(key);
    await runCategoryDigestJob(context);
    expect(prompts[0]).toStartWith("你是严谨的中文 RSS 日报资深编辑。");
  });
});
