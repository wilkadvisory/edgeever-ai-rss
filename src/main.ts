import { CATEGORIES, DEFAULT_CATEGORY_IDS } from "./catalog";
import { articleFreshness, clusterRelatedArticles } from "./dedupe";
import type { EdgeEverPlugin, PluginContext } from "./edgeever";
import { buildDigestMarkdown, DAILY_DIGEST_TAG, digestArticlePayload, digestDateKey, digestTags, digestTitle, recentCategoryArticles } from "./digest";
import { fetchFeed } from "./feed";
import type { Article } from "./feed";
import { digestCategoryName, digestSystemPrompt, onHostLanguageChange, t, translationSystemPrompt, uiCategoryName } from "./i18n";
import { createLatestTaskQueue } from "./latest-task-queue";
import { AUTO_DIGEST_KEY, DIGEST_GENERATION_TIME_KEY, digestCronExpression, loadReaderPreferences, migrateLegacyCategorySettings } from "./settings";
import { loadSubscriptions, selectSources } from "./subscriptions";
import { registerSubscriptionPanel } from "./subscription-panel";
import {
  applyHeadlineTranslation,
  headlineTranslationIsCurrent,
  parseHeadlineTranslations,
  sourceAlreadyMatchesTarget,
} from "./translation";
import type { HeadlineTranslation, TranslationTarget } from "./translation";

const STATE_KEY = "reader-state-v1";
const MAX_CACHED_ARTICLES = 240;
const AUTO_TRANSLATION_BATCH_SIZE = 8;
const DAILY_DIGEST_COMMAND_ID = "generate-daily-category-digests";
const LEGACY_DAILY_DIGEST_SCHEDULE_KEY = "daily-category-digests";
const DAILY_DIGEST_SCHEDULE_KEY = "daily-category-digests-v2";

interface ReaderState {
  selectedCategoryIds: string[];
  selectedNotebookId: string | null;
  articles: Article[];
  aiReadings: Record<string, { headlineTranslation?: HeadlineTranslation }>;
  refreshedAt: string | null;
}

const initialState = (): ReaderState => ({
  selectedCategoryIds: [...DEFAULT_CATEGORY_IDS],
  selectedNotebookId: null,
  articles: [],
  aiReadings: {},
  refreshedAt: null,
});

const mapLimit = async <T, R>(items: T[], limit: number, task: (item: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> => {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor++;
      try {
        results[index] = { status: "fulfilled", value: await task(items[index]!) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
};

const mergeArticles = (state: ReaderState, articles: Article[], sourceIds: Set<string>): ReaderState => {
  const merged = new Map(state.articles.filter((article) => sourceIds.has(article.sourceId)).map((article) => [article.id, article]));
  for (const article of articles) merged.set(article.id, article);
  const clustered = clusterRelatedArticles([...merged.values()].filter((article) => state.selectedCategoryIds.includes(article.categoryId)));
  const representativeByArticleId = new Map<string, string>();
  for (const article of clustered) {
    representativeByArticleId.set(article.id, article.id);
    for (const coverage of article.relatedCoverage ?? []) representativeByArticleId.set(coverage.articleId, article.id);
  }
  const aiReadings = { ...state.aiReadings };
  for (const [articleId, reading] of Object.entries(state.aiReadings)) {
    const representativeId = representativeByArticleId.get(articleId);
    if (representativeId && !aiReadings[representativeId]) aiReadings[representativeId] = reading;
  }
  return {
    ...state,
    articles: clustered.sort((a, b) => articleFreshness(b).localeCompare(articleFreshness(a))).slice(0, MAX_CACHED_ARTICLES),
    aiReadings,
  };
};

const translateHeadlines = async (
  context: PluginContext,
  state: ReaderState,
  target: TranslationTarget,
  articleIds: Set<string>,
): Promise<void> => {
  const pending = state.articles.filter((article) =>
    articleIds.has(article.id)
    && !sourceAlreadyMatchesTarget(article, target)
    && !headlineTranslationIsCurrent(article, state.aiReadings[article.id]?.headlineTranslation, target),
  );
  const batches = Array.from(
    { length: Math.ceil(pending.length / AUTO_TRANSLATION_BATCH_SIZE) },
    (_, index) => pending.slice(index * AUTO_TRANSLATION_BATCH_SIZE, (index + 1) * AUTO_TRANSLATION_BATCH_SIZE),
  );
  for (const batch of batches) {
    try {
      const result = await context.ai.generate({
        system: translationSystemPrompt(target),
        prompt: JSON.stringify(batch.map((article, index) => ({
          index,
          title: article.title,
          summary: article.summary.slice(0, 800),
        }))),
        maxOutputTokens: 1_500,
      });
      for (const [articleId, translation] of parseHeadlineTranslations(result.text, batch, target)) {
        state.aiReadings[articleId] = { ...state.aiReadings[articleId], headlineTranslation: translation };
      }
    } catch {
      // A failed translation batch must not prevent RSS reading or digest generation.
    }
  }
};

interface DigestJobResult {
  created: number;
  updated: number;
  failed: number;
  failureDetails: string[];
}

const failureMessage = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/https?:\/\/\S+/gi, t("error.linkOmitted")).replace(/\s+/g, " ").slice(0, 240) || t("error.unknown");
};

const affordableOutputTokens = (error: unknown, requested: number): number | null => {
  const message = error instanceof Error ? error.message : String(error);
  const available = Number(/can only afford\s+(\d+)/i.exec(message)?.[1]);
  if (!Number.isSafeInteger(available) || available < 1_000 || available >= requested) return null;
  return Math.min(available - 100, Math.floor(available * 0.85));
};

export const generateDigestText = async (context: PluginContext, system: string, prompt: string): Promise<string> => {
  const maxOutputTokens = 3_000;
  try {
    return (await context.ai.generate({ system, prompt, maxOutputTokens })).text;
  } catch (error) {
    const retryTokens = affordableOutputTokens(error, maxOutputTokens);
    if (retryTokens === null) throw error;
    return (await context.ai.generate({ system, prompt, maxOutputTokens: retryTokens })).text;
  }
};

export const runCategoryDigestJob = async (context: PluginContext): Promise<DigestJobResult> => {
  const stored = await context.storage.get<ReaderState>(STATE_KEY);
  let state = stored ? { ...initialState(), ...stored } : initialState();
  const notebooks = await context.notebooks.list();
  const notebook = notebooks.find((candidate) => candidate.id === state.selectedNotebookId) ?? notebooks[0];
  if (!notebook) throw new Error(t("error.noNotebook"));
  const notebookId = notebook.id;
  state.selectedNotebookId = notebookId;

  if (!(await context.ai.status()).configured) throw new Error(t("error.aiNotConfigured"));

  const preferences = await loadReaderPreferences(context);
  state.selectedCategoryIds = preferences.selectedCategoryIds;
  const categories = CATEGORIES.filter((category) => preferences.selectedCategoryIds.includes(category.id));
  if (!categories.length) throw new Error(t("error.noTopics"));

  const sources = selectSources(state.selectedCategoryIds, await loadSubscriptions(context));
  const fetched = await mapLimit(sources, 3, (source) => fetchFeed(context, source));
  state = mergeArticles(state, fetched.flatMap((result) => result.status === "fulfilled" ? result.value : []), new Set(sources.map((source) => source.id)));
  state.refreshedAt = new Date().toISOString();
  await context.storage.set(STATE_KEY, state);

  // The saved note follows the target language setting; messages follow the interface language.
  const language = preferences.translationTarget;
  const generatedAt = new Date();
  const dateKey = digestDateKey(generatedAt);
  const pending = categories.flatMap((category) => {
    const articles = recentCategoryArticles(state.articles, category.id, generatedAt, preferences.digestMaxArticles, preferences.digestWindowHours)
      .map((article) => applyHeadlineTranslation(article, state.aiReadings[article.id]?.headlineTranslation, preferences.translationTarget));
    return articles.length ? [{ category, articles }] : [];
  });
  let created = 0;
  let updated = 0;
  let failed = 0;
  const failureDetails: string[] = [];

  for (const item of pending) {
    let stage = t("stage.generate");
    try {
      const categoryName = digestCategoryName(item.category.id, language, item.category.name);
      const title = digestTitle(dateKey, categoryName, language);
      const aiMarkdown = await generateDigestText(
        context,
        digestSystemPrompt(language),
        JSON.stringify({ category: categoryName, articles: digestArticlePayload(item.articles) }),
      );
      const tags = digestTags(dateKey, item.category.id);
      const contentMarkdown = buildDigestMarkdown({ title, category: item.category, generatedAt, articles: item.articles, aiMarkdown, windowHours: preferences.digestWindowHours, language });
      stage = t("stage.lookup");
      const matches = await context.notes.query({
        notebookId,
        tags: [DAILY_DIGEST_TAG, `AI-RSS-Category-${item.category.id}`, `AI-RSS-Date-${dateKey}`],
        sort: "updated-desc",
        limit: 10,
      });
      const existing = matches.notes[0];
      stage = existing ? t("stage.update") : t("stage.save");
      if (existing) {
        await context.notes.update(existing.id, { title, contentMarkdown, tags });
        updated += 1;
      } else {
        await context.notes.create({ notebookId, title, contentMarkdown, tags });
        created += 1;
      }
    } catch (error) {
      failed += 1;
      const detail = t("failure.detail", { category: uiCategoryName(item.category.id, item.category.name), stage, message: failureMessage(error) });
      failureDetails.push(detail);
      console.error("EdgeEver RSS category digest failed.", { category: item.category.id, stage, error });
    }
  }

  if (preferences.autoTranslate && created + updated > 0) {
    await translateHeadlines(context, state, preferences.translationTarget, new Set(pending.flatMap((item) => item.articles.map((article) => article.id))));
    await context.storage.set(STATE_KEY, state);
  }

  return { created, updated, failed, failureDetails };
};

const syncDailyDigestSchedule = async (context: PluginContext): Promise<void> => {
  if (!context.schedules) return;
  const preferences = await loadReaderPreferences(context);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone?.trim() || "UTC";
  await context.schedules.upsert({
    key: DAILY_DIGEST_SCHEDULE_KEY,
    name: t("schedule.name", { time: preferences.digestGenerationTime }),
    commandId: DAILY_DIGEST_COMMAND_ID,
    cronExpression: digestCronExpression(preferences.digestGenerationTime),
    timezone,
    missedRunPolicy: "run-once",
    isEnabled: preferences.autoDigest,
  });
};

const desktopSchedulesUnavailable = (error: unknown) =>
  error instanceof Error && error.message.includes("only available in the EdgeEver desktop app");

const syncDailyDigestScheduleWithRetry = async (context: PluginContext): Promise<void> => {
  try {
    await syncDailyDigestSchedule(context);
  } catch (error) {
    if (desktopSchedulesUnavailable(error)) return;
    await syncDailyDigestSchedule(context);
  }
};

const plugin: EdgeEverPlugin = {
  async activate(context) {
    const stored = await context.storage.get<ReaderState>(STATE_KEY);
    const legacySchedules = await context.schedules?.list().catch(() => []);
    const legacyAutoDigestEnabled = legacySchedules?.some((schedule) => schedule.key === LEGACY_DAILY_DIGEST_SCHEDULE_KEY && schedule.isEnabled) ?? false;
    await migrateLegacyCategorySettings(context, stored?.selectedCategoryIds ?? null, legacyAutoDigestEnabled);

    // Command and panel titles are fixed at registration, so register them again
    // when the interface language changes while the plugin stays active.
    const registerInterface = (): (() => void) => {
      const disposeDigestCommand = context.commands.register({
        id: DAILY_DIGEST_COMMAND_ID,
        title: t("command.generate"),
        run: async () => {
          const result = await runCategoryDigestJob(context);
          if (result.failed > 0 && result.created + result.updated === 0) {
            throw new Error(t("error.allFailed", {
              count: result.failed,
              details: result.failureDetails.join(t("error.detailSeparator")),
            }));
          }
        },
      });
      const disposeSubscriptions = registerSubscriptionPanel(context);
      return () => {
        disposeDigestCommand();
        disposeSubscriptions();
      };
    };
    let disposeInterface = registerInterface();
    const scheduleSync = createLatestTaskQueue();
    const enqueueScheduleSync = () => scheduleSync.enqueue(() => syncDailyDigestScheduleWithRetry(context));
    const disposeSettingsChanged = context.events.on("settings.changed", async ({ key }) => {
      if (key !== AUTO_DIGEST_KEY && key !== DIGEST_GENERATION_TIME_KEY) return;
      const run = enqueueScheduleSync();
      try {
        await run;
      } catch (error) {
        if (!scheduleSync.isLatest(run) || desktopSchedulesUnavailable(error)) return;
        console.error("EdgeEver RSS daily digest schedule update failed.", error);
        const detail = error instanceof Error ? error.message : t("error.unknown");
        context.ui.showNotice(t("notice.scheduleNotUpdated", { detail }));
      }
    });
    await context.schedules?.remove(LEGACY_DAILY_DIGEST_SCHEDULE_KEY).catch(() => undefined);
    await enqueueScheduleSync().catch((error) => {
      console.error("EdgeEver RSS daily digest schedule update failed.", error);
    });
    const disposeLanguageWatcher = onHostLanguageChange(() => {
      disposeInterface();
      disposeInterface = registerInterface();
      // The schedule name is shown in EdgeEver's schedule list, so rename it too.
      void enqueueScheduleSync().catch((error) => {
        if (!desktopSchedulesUnavailable(error)) console.error("EdgeEver RSS daily digest schedule update failed.", error);
      });
    });
    return () => {
      disposeLanguageWatcher();
      disposeSettingsChanged();
      disposeInterface();
    };
  },
};

export default plugin;
