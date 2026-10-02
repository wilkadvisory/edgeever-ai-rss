import { CATEGORIES, FEEDS } from "./catalog";
import { COMMUNITY_DIRECTORY } from "./community-directory";
import { fetchCommunityDirectory, type DirectorySource } from "./discovery";
import type { PluginContext } from "./edgeever";
import { fetchFeed } from "./feed";
import { t, uiCategoryName } from "./i18n";
import { createPersonalSource, loadSubscriptions, MAX_PERSONAL_SOURCES, saveSubscriptions, type PersonalSource, type Subscriptions } from "./subscriptions";

const PANEL_ID = "explore-subscriptions";
type Tab = "featured" | "community" | "personal";

const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, label?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (label) node.textContent = label;
  return node;
};

const button = (label: string, click: () => void, disabled = false): HTMLButtonElement => {
  const node = element("button", "edgeever-rss-button", label);
  node.type = "button";
  node.disabled = disabled;
  node.addEventListener("click", click);
  return node;
};

export const registerSubscriptionPanel = (context: PluginContext): (() => void) => {
  const disposePanel = context.ui.panels.register({
    id: PANEL_ID,
    title: t("panel.title"),
    purpose: "workflow",
    presentation: "fullscreen",
    async mount(container, panel) {
      let alive = true;
      let tab: Tab = "featured";
      let query = "";
      let shown = 50;
      let busy = false;
      let message = "";
      let subscriptions: Subscriptions = await loadSubscriptions(context);
      let directory: DirectorySource[] = COMMUNITY_DIRECTORY;
      let directoryLoading = false;
      let customUrl = "";
      let customName = "";
      let customCategory = "chinese";
      let customLanguage: "zh" | "en" = "zh";

      const syncChrome = () => panel.shell.set({
        header: { title: t("panel.title"), description: t("panel.description") },
        toolbar: [
          { type: "tabs", key: "tab", value: tab, options: [
            { value: "featured", label: t("tab.featured") },
            { value: "community", label: t("tab.community") },
            { value: "personal", label: t("tab.personal") },
          ] },
          { type: "search", key: "query", value: query, placeholder: t("search.placeholder") },
        ],
        onChange: (key, value) => {
          if (key === "tab" && (value === "featured" || value === "community" || value === "personal")) {
            tab = value;
            query = "";
            shown = 50;
            message = "";
          } else if (key === "query") {
            query = value;
            shown = 50;
          }
          render();
        },
      });

      const save = async (next: Subscriptions) => {
        busy = true;
        render();
        try {
          await saveSubscriptions(context, next);
          subscriptions = next;
          message = t("message.saved");
        } catch (error) {
          message = error instanceof Error ? error.message : t("message.saveFailed");
        } finally {
          busy = false;
          render();
        }
      };

      const loadDirectory = async () => {
        if (directoryLoading) return;
        directoryLoading = true;
        render();
        try {
          directory = await fetchCommunityDirectory(context);
          message = t("message.directoryLoaded", { count: directory.length });
        } catch (error) {
          message = error instanceof Error ? error.message : t("message.directoryFailed");
        } finally {
          directoryLoading = false;
          render();
        }
      };

      const subscribePersonal = async (source: PersonalSource) => {
        if (busy) return;
        if (subscriptions.personal.length >= MAX_PERSONAL_SOURCES) {
          message = t("message.personalLimit", { max: MAX_PERSONAL_SOURCES });
          render();
          return;
        }
        if (subscriptions.personal.some((item) => item.url === source.url) || FEEDS.some((item) => item.url === source.url)) {
          message = t("message.duplicate");
          render();
          return;
        }
        busy = true;
        message = t("message.verifying", { name: source.name });
        render();
        try {
          await fetchFeed(context, { ...source, siteUrl: new URL(source.url).origin });
          await saveSubscriptions(context, { ...subscriptions, personal: [...subscriptions.personal, source] });
          subscriptions = await loadSubscriptions(context);
          customUrl = "";
          customName = "";
          message = t("message.subscribed", { name: source.name });
        } catch (error) {
          message = error instanceof Error ? error.message : t("message.verifyFailed");
        } finally {
          busy = false;
          render();
        }
      };

      const matches = (name: string, url: string) => `${name} ${url}`.toLocaleLowerCase().includes(query.toLocaleLowerCase().trim());

      const sourceRow = (name: string, url: string, subtitle: string, actionLabel: string, action: () => void, disabled = false) => {
        const row = element("div", "edgeever-rss-row");
        const details = element("div", "edgeever-rss-row-details");
        details.append(element("div", "edgeever-rss-row-title", name), element("div", "edgeever-rss-row-subtitle", subtitle));
        row.append(details, button(actionLabel, action, disabled || busy));
        return row;
      };

      const renderFeatured = (root: HTMLElement) => {
        const feeds = FEEDS.filter((feed) => feed.optional && matches(feed.name, feed.url));
        root.append(element("p", "edgeever-rss-muted", t("featured.intro")));
        if (!feeds.length) root.append(element("p", "edgeever-rss-muted", t("featured.empty")));
        for (const feed of feeds) {
          const selected = subscriptions.featuredIds.includes(feed.id);
          const category = uiCategoryName(feed.categoryId, CATEGORIES.find((item) => item.id === feed.categoryId)?.name);
          root.append(sourceRow(feed.name, feed.url, `${category} · ${new URL(feed.siteUrl).hostname}`, selected ? t("action.unsubscribe") : t("action.subscribe"), () => {
            void save({ ...subscriptions, featuredIds: selected
              ? subscriptions.featuredIds.filter((id) => id !== feed.id)
              : [...subscriptions.featuredIds, feed.id] });
          }));
        }
      };

      const renderCommunity = (root: HTMLElement) => {
        root.append(element("p", "edgeever-rss-muted", t("community.intro", { count: COMMUNITY_DIRECTORY.length })));
        root.append(button(directoryLoading ? t("community.refreshing") : t("community.refresh"), () => void loadDirectory(), directoryLoading));
        const feeds = directory.filter((source) => matches(source.name, source.url));
        root.append(element("p", "edgeever-rss-muted", t("community.count", { matched: feeds.length, shown: Math.min(shown, feeds.length) })));
        for (const source of feeds.slice(0, shown)) {
          const selected = subscriptions.personal.some((item) => item.url === source.url) || FEEDS.some((item) => item.url === source.url);
          root.append(sourceRow(source.name, source.url, source.siteUrl ?? new URL(source.url).hostname, selected ? t("action.subscribed") : t("action.subscribeChinese"), () => {
            const personal = createPersonalSource(source.url, source.name, "chinese", "zh");
            if (personal) void subscribePersonal(personal);
          }, selected));
        }
        if (shown < feeds.length) root.append(button(t("action.showMore"), () => { shown += 50; render(); }));
      };

      const renderPersonal = (root: HTMLElement) => {
        const form = element("form", "edgeever-rss-form");
        const url = element("input", "edgeever-rss-input");
        url.type = "url";
        url.placeholder = "https://example.com/feed.xml";
        url.value = customUrl;
        url.setAttribute("aria-label", t("personal.urlLabel"));
        url.addEventListener("input", () => { customUrl = url.value; });
        const name = element("input", "edgeever-rss-input");
        name.type = "text";
        name.placeholder = t("personal.namePlaceholder");
        name.value = customName;
        name.setAttribute("aria-label", t("personal.nameLabel"));
        name.addEventListener("input", () => { customName = name.value; });
        const category = element("select", "edgeever-rss-input");
        category.setAttribute("aria-label", t("personal.topicLabel"));
        for (const item of CATEGORIES) {
          const option = element("option");
          option.value = item.id;
          option.textContent = uiCategoryName(item.id, item.name);
          category.append(option);
        }
        category.value = customCategory;
        category.addEventListener("change", () => { customCategory = category.value; });
        const language = element("select", "edgeever-rss-input");
        language.setAttribute("aria-label", t("personal.languageLabel"));
        for (const [value, label] of [["zh", t("language.zh")], ["en", t("language.en")]] as const) {
          const option = element("option");
          option.value = value;
          option.textContent = label;
          language.append(option);
        }
        language.value = customLanguage;
        language.addEventListener("change", () => { customLanguage = language.value === "en" ? "en" : "zh"; });
        const submit = button(t("action.add"), () => undefined, busy);
        submit.type = "submit";
        form.append(url, name, category, language, submit);
        form.addEventListener("submit", (event) => {
          event.preventDefault();
          const source = createPersonalSource(customUrl, customName, customCategory, customLanguage);
          if (!source) {
            message = t("personal.invalid");
            render();
            return;
          }
          void subscribePersonal(source);
        });
        root.append(form, element("p", "edgeever-rss-muted", t("personal.count", { count: subscriptions.personal.length, max: MAX_PERSONAL_SOURCES })));
        const sources = subscriptions.personal.filter((source) => matches(source.name, source.url));
        if (!sources.length) root.append(element("p", "edgeever-rss-muted", t("personal.empty")));
        for (const source of sources) {
          const topic = uiCategoryName(source.categoryId, CATEGORIES.find((item) => item.id === source.categoryId)?.name);
          root.append(sourceRow(source.name, source.url, `${topic} · ${source.url}`, t("action.unsubscribe"), () => {
            void save({ ...subscriptions, personal: subscriptions.personal.filter((item) => item.id !== source.id) });
          }));
        }
      };

      const render = () => {
        if (!alive) return;
        syncChrome();
        const root = element("div", "edgeever-rss-panel");
        if (message) root.append(element("p", "edgeever-rss-message", message));
        if (tab === "featured") renderFeatured(root);
        else if (tab === "community") renderCommunity(root);
        else renderPersonal(root);
        container.replaceChildren(root);
      };
      render();
      return () => { alive = false; };
    },
  });
  const disposeCommand = context.commands.register({
    id: PANEL_ID,
    title: t("command.manage"),
    run: () => context.ui.panels.open(PANEL_ID),
  });
  return () => { disposeCommand(); disposePanel(); };
};
