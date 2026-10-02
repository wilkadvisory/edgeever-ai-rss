import { afterEach, describe, expect, test } from "bun:test";
import { CATEGORIES } from "../src/catalog";
import {
  digestCategoryName,
  digestLanguageForHost,
  digestSystemPrompt,
  resolveUiLocale,
  setHostLanguageOverride,
  t,
  translationSystemPrompt,
  UI_LOCALES,
  uiCategoryName,
} from "../src/i18n";
import type { MessageKey } from "../src/i18n";
import { TRANSLATION_TARGETS } from "../src/translation";

const KEYS: MessageKey[] = [
  "command.generate", "command.manage", "schedule.name", "error.allFailed", "error.directoryHttp", "failure.detail",
  "notice.scheduleNotUpdated", "message.directoryLoaded", "message.personalLimit", "message.verifying",
  "message.subscribed", "community.intro", "community.count", "personal.count", "panel.title", "action.subscribe",
];
const placeholders = (value: string): string[] => [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!).sort();

describe("interface language", () => {
  afterEach(() => setHostLanguageOverride(null));

  test("maps EdgeEver interface languages to bundled copy", () => {
    expect(resolveUiLocale("zh-CN")).toBe("zh-CN");
    expect(resolveUiLocale("zh-TW")).toBe("zh-CN");
    expect(resolveUiLocale("en-US")).toBe("en");
    expect(resolveUiLocale("ja")).toBe("ja");
    expect(resolveUiLocale("de-DE")).toBe("en");
    expect(resolveUiLocale("")).toBe("en");
  });

  test("follows the host language and keeps the original Chinese copy", () => {
    setHostLanguageOverride("zh-CN");
    expect(t("command.generate")).toBe("生成今日 RSS 分类日报");
    expect(t("message.verifying", { name: "Feed" })).toBe("正在验证 Feed…");
    setHostLanguageOverride("en-US");
    expect(t("command.generate")).toBe("Generate today's RSS topic digests");
    expect(t("message.personalLimit", { max: 30 })).toBe("You can subscribe to at most 30 personal feeds.");
    expect(uiCategoryName("ai")).toBe("AI Frontiers");
  });

  test("keeps the same placeholders in every language and no Chinese in English copy", () => {
    for (const key of KEYS) {
      const expected = placeholders(t(key, undefined, "zh-CN"));
      for (const locale of UI_LOCALES) expect(placeholders(t(key, undefined, locale))).toEqual(expected);
      expect(t(key, undefined, "en")).not.toMatch(/[\u3040-\u30ff\u4e00-\u9fff]/);
    }
  });
});

describe("digest language", () => {
  test("resolves the interface language to a digest language", () => {
    expect(digestLanguageForHost("en-US")).toBe("en");
    expect(digestLanguageForHost("zh-CN")).toBe("zh-CN");
    expect(digestLanguageForHost("zh_TW")).toBe("zh-TW");
    expect(digestLanguageForHost("zh-Hant-HK")).toBe("zh-TW");
    expect(digestLanguageForHost("ja")).toBe("ja");
    expect(digestLanguageForHost("ko-KR")).toBe("ko");
    expect(digestLanguageForHost("es")).toBe("en");
  });

  test("names every topic in every digest language and matches the catalog in Chinese", () => {
    for (const category of CATEGORIES) {
      expect(digestCategoryName(category.id, "zh-CN")).toBe(category.name);
      for (const language of TRANSLATION_TARGETS) expect(digestCategoryName(category.id, language, "")).toBeTruthy();
    }
    expect(digestCategoryName("custom", "en", "Custom")).toBe("Custom");
  });

  test("keeps the citation marker contract in every prompt", () => {
    for (const language of TRANSLATION_TARGETS) {
      const prompt = digestSystemPrompt(language);
      expect(prompt).toContain("〔1〕 · 〔2〕");
      expect(prompt).toContain("## 01 | ");
      expect(prompt).toContain("---");
    }
    expect(digestSystemPrompt("zh-CN")).toContain("> 🔗 **信源**：〔数字〕");
    expect(digestSystemPrompt("zh-TW")).toContain("繁體中文");
    expect(digestSystemPrompt("en")).toContain("> 🔗 **Sources**: 〔number〕");
    expect(digestSystemPrompt("ja")).toContain("Write the entire digest in Japanese");
    expect(digestSystemPrompt("ko")).toContain("**출처**");
  });

  test("writes the translation prompt for the target language", () => {
    expect(translationSystemPrompt("zh-CN")).toContain("忠实翻译为简体中文");
    expect(translationSystemPrompt("en")).toContain("faithfully into English");
    expect(translationSystemPrompt("ja")).toContain("\"index\":number");
  });
});
