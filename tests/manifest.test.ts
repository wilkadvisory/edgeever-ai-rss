import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));

describe("plugin manifest", () => {
  test("ships Simplified Chinese and Japanese marketplace descriptions", () => {
    for (const locale of ["zh-CN", "ja"]) {
      expect(manifest.locales?.[locale]?.description).toBeTruthy();
    }
  });

  test("uses English setting copy as the fallback and localizes every field", () => {
    for (const field of manifest.settings.fields) {
      expect(field.label).not.toMatch(/[\u3040-\u30ff\u4e00-\u9fff]/);
      for (const locale of ["zh-CN", "ja"]) expect(field.locales?.[locale]?.label).toBeTruthy();
      // Setting lists cannot be localized per field, so the host supplies their copy.
      expect(field.list?.title).toBeUndefined();
      expect(field.list?.actionLabel).toBeUndefined();
    }
  });

  test("defaults the digest and translation language to the interface language", () => {
    const field = manifest.settings.fields.find((candidate: { key: string }) => candidate.key === "translation.target-language");
    expect(field.default).toBe("auto");
    expect(field.options.map((option: { value: string }) => option.value)).toEqual(["auto", "zh-CN", "zh-TW", "en", "ja", "ko"]);
    expect(Object.keys(field.locales["zh-CN"].options)).toEqual(["auto", "zh-CN", "zh-TW", "en", "ja", "ko"]);
  });
});
