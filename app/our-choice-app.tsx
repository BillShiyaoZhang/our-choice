"use client";

/* eslint-disable @next/next/no-img-element -- feed images come from user-selected dynamic RSS sources */

import {
  ArrowRight,
  Bookmark,
  Check,
  CheckCheck,
  ChevronRight,
  CirclePlay,
  Compass,
  Download,
  ExternalLink,
  FileText,
  FolderPlus,
  Headphones,
  Home,
  Inbox,
  Library,
  Link2,
  LockKeyhole,
  Menu,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Rss,
  Search,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Upload,
  WifiOff,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  type ChangeEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  contentTypeLabels,
  defaultAppData,
  platformLabels,
  suggestedCollections,
  type AppData,
  type Collection,
  type ContentItem,
  type ContentType,
  type Source,
  type SuggestedCollection,
  type View,
  type VisualTone,
} from "./lib/model";

const STORAGE_KEY = "our-choice:state:v1";
const TONES: VisualTone[] = ["forest", "clay", "ocean", "sun", "plum", "ink"];

type TypeFilter = "all" | ContentType;
type DiscoverMode = "near" | "step" | "random";

interface PreviewItem {
  upstreamId: string;
  title: string;
  url: string;
  summary: string;
  type: ContentType;
  thumbnailUrl?: string;
  publishedAt: string;
  duration: string;
}

interface PreviewSuccess {
  ok: true;
  mode: "live" | "link-only";
  source: {
    kind: "rss" | "bilibili";
    title: string;
    description?: string;
    feedUrl?: string;
    siteUrl?: string;
    profileUrl?: string;
    mid?: string;
    imageUrl?: string;
  };
  items: PreviewItem[];
  warning?: { code: string; message: string };
}

interface PreviewFailure {
  ok: false;
  error: { code: string; message: string; retryable: boolean };
}

type PreviewResponse = PreviewSuccess | PreviewFailure;

interface ToastState {
  message: string;
  actionLabel?: string;
  onAction?: () => void;
}

interface ConfirmState {
  title: string;
  description: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
}

const navItems: Array<{
  id: View;
  label: string;
  icon: LucideIcon;
}> = [
  { id: "today", label: "今日", icon: Home },
  { id: "discover", label: "发现", icon: Compass },
  { id: "collections", label: "合集", icon: Library },
  { id: "subscriptions", label: "订阅", icon: Rss },
];

function cloneDefaultData(): AppData {
  return JSON.parse(JSON.stringify(defaultAppData)) as AppData;
}

function createId(prefix: string) {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function stableKey(value: string) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function relativeTimeLabel(value: string) {
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return "刚刚";
  const diffMinutes = Math.max(0, Math.floor((Date.now() - time) / 60_000));
  if (diffMinutes < 1) return "刚刚";
  if (diffMinutes < 60) return `${diffMinutes} 分钟前`;
  if (diffMinutes < 24 * 60) return `${Math.floor(diffMinutes / 60)} 小时前`;
  if (diffMinutes < 48 * 60) return "昨天";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
  }).format(new Date(time));
}

function dateGroup(value: string): ContentItem["dateGroup"] {
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return "更早";
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (time >= start) return "今天";
  if (time >= start - 24 * 60 * 60 * 1_000) return "昨天";
  return "更早";
}

function sourceForItem(data: AppData, item: ContentItem) {
  return data.sources.find((source) => source.id === item.sourceId);
}

function isValidImport(value: unknown): value is AppData {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<AppData>;
  return (
    candidate.version === 1 &&
    Array.isArray(candidate.sources) &&
    Array.isArray(candidate.items) &&
    Array.isArray(candidate.collections) &&
    Boolean(candidate.settings && typeof candidate.settings === "object")
  );
}

export function OurChoiceApp() {
  const [data, setData] = useState<AppData>(cloneDefaultData);
  const [hydrated, setHydrated] = useState(false);
  const [view, setView] = useState<View>("today");
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [saveItemId, setSaveItemId] = useState<string | null>(null);
  const [openCollectionId, setOpenCollectionId] = useState<string | null>(null);
  const [openSuggestionId, setOpenSuggestionId] = useState<string | null>(null);
  const [focusOpen, setFocusOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [online, setOnline] = useState(true);
  const [discoverMode, setDiscoverMode] = useState<DiscoverMode>("near");
  const searchRef = useRef<HTMLInputElement>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      try {
        const saved = window.localStorage.getItem(STORAGE_KEY);
        if (saved) {
          const parsed: unknown = JSON.parse(saved);
          if (isValidImport(parsed)) setData(parsed);
        }
      } catch {
        // A malformed local backup should never prevent the app from opening.
      }
      setHydrated(true);
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch {
      // The current in-memory session remains usable if the browser quota is full.
    }
  }, [data, hydrated]);

  useEffect(() => {
    function handleStorage(event: StorageEvent) {
      if (event.key !== STORAGE_KEY || !event.newValue) return;
      try {
        const parsed: unknown = JSON.parse(event.newValue);
        if (isValidImport(parsed)) setData(parsed);
      } catch {
        // Ignore invalid data written by another tab.
      }
    }

    function updateNetworkState() {
      setOnline(navigator.onLine);
    }

    function handleShortcut(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const isTyping =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable;
      if (event.key === "/" && !isTyping) {
        event.preventDefault();
        searchRef.current?.focus();
      }
      if (event.key === "Escape" && query && !isTyping) setQuery("");
    }

    updateNetworkState();
    window.addEventListener("storage", handleStorage);
    window.addEventListener("online", updateNetworkState);
    window.addEventListener("offline", updateNetworkState);
    window.addEventListener("keydown", handleShortcut);
    return () => {
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener("online", updateNetworkState);
      window.removeEventListener("offline", updateNetworkState);
      window.removeEventListener("keydown", handleShortcut);
    };
  }, [query]);

  useEffect(() => {
    return () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, []);

  const activeSources = useMemo(
    () => data.sources.filter((source) => !source.archived),
    [data.sources],
  );

  const inboxItems = useMemo(() => {
    const activeIds = new Set(
      activeSources.filter((source) => source.enabled).map((source) => source.id),
    );
    return data.items.filter((item) => activeIds.has(item.sourceId));
  }, [activeSources, data.items]);

  const unreadCount = inboxItems.filter((item) => !item.read).length;
  const laterCollection = data.collections.find((collection) => collection.isSystem);
  const laterCount = laterCollection?.itemIds.length ?? 0;

  const searchedItems = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
    return data.items.filter((item) => {
      if (!normalizedQuery) return false;
      const source = sourceForItem(data, item);
      return [item.title, item.summary, source?.name ?? ""]
        .join(" ")
        .toLocaleLowerCase("zh-CN")
        .includes(normalizedQuery);
    });
  }, [data, query]);

  function showToast(next: ToastState) {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(next);
    toastTimer.current = setTimeout(() => setToast(null), 5_000);
  }

  function goTo(next: View) {
    setView(next);
    setMobileMenuOpen(false);
    setQuery("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function setItemRead(itemId: string, read: boolean) {
    setData((current) => {
      const item = current.items.find((candidate) => candidate.id === itemId);
      if (!item || item.read === read) return current;
      return {
        ...current,
        items: current.items.map((candidate) =>
          candidate.id === itemId ? { ...candidate, read } : candidate,
        ),
        sources: current.sources.map((source) =>
          source.id === item.sourceId
            ? {
                ...source,
                unreadCount: Math.max(0, source.unreadCount + (read ? -1 : 1)),
              }
            : source,
        ),
      };
    });
  }

  function markReadWithUndo(itemId: string) {
    const item = data.items.find((candidate) => candidate.id === itemId);
    if (!item || item.read) return;
    setItemRead(itemId, true);
    showToast({
      message: "已标记为读过",
      actionLabel: "撤销",
      onAction: () => setItemRead(itemId, false),
    });
  }

  function markAllRead() {
    const changedIds = inboxItems.filter((item) => !item.read).map((item) => item.id);
    if (!changedIds.length) {
      showToast({ message: "今天的内容已经全部读完" });
      return;
    }
    const changedSet = new Set(changedIds);
    setData((current) => ({
      ...current,
      items: current.items.map((item) =>
        changedSet.has(item.id) ? { ...item, read: true } : item,
      ),
      sources: current.sources.map((source) =>
        source.enabled && !source.archived ? { ...source, unreadCount: 0 } : source,
      ),
    }));
    showToast({
      message: `已读完 ${changedIds.length} 条内容`,
      actionLabel: "撤销",
      onAction: () => {
        setData((current) => ({
          ...current,
          items: current.items.map((item) =>
            changedSet.has(item.id) ? { ...item, read: false } : item,
          ),
          sources: current.sources.map((source) => ({
            ...source,
            unreadCount: current.items.filter(
              (item) => item.sourceId === source.id && changedSet.has(item.id),
            ).length,
          })),
        }));
      },
    });
  }

  function toggleItemInCollection(itemId: string, collectionId: string) {
    const collection = data.collections.find((candidate) => candidate.id === collectionId);
    const item = data.items.find((candidate) => candidate.id === itemId);
    if (!collection || !item) return;
    const alreadySaved = collection.itemIds.includes(itemId);

    setItemCollectionMembership(itemId, collectionId, !alreadySaved);

    showToast({
      message: alreadySaved ? `已从「${collection.title}」移除` : `已加入「${collection.title}」`,
      actionLabel: "撤销",
      onAction: () => setItemCollectionMembership(itemId, collectionId, alreadySaved),
    });
  }

  function setItemCollectionMembership(
    itemId: string,
    collectionId: string,
    shouldSave: boolean,
  ) {

    setData((current) => ({
      ...current,
      collections: current.collections.map((candidate) =>
        candidate.id === collectionId
          ? {
              ...candidate,
              itemIds: shouldSave
                ? candidate.itemIds.includes(itemId)
                  ? candidate.itemIds
                  : [itemId, ...candidate.itemIds]
                : candidate.itemIds.filter((id) => id !== itemId),
              updatedLabel: "刚刚",
            }
          : candidate,
      ),
      items: current.items.map((candidate) =>
        candidate.id === itemId
          ? {
              ...candidate,
              collectionIds: shouldSave
                ? candidate.collectionIds.includes(collectionId)
                  ? candidate.collectionIds
                  : [...candidate.collectionIds, collectionId]
                : candidate.collectionIds.filter((id) => id !== collectionId),
            }
          : candidate,
      ),
    }));
  }

  function toggleLater(itemId: string) {
    if (!laterCollection) return;
    toggleItemInCollection(itemId, laterCollection.id);
  }

  function openSaveDialog(itemId: string) {
    setOpenCollectionId(null);
    setSaveItemId(itemId);
  }

  function createCollection(title: string, description: string) {
    const normalized = title.trim();
    if (!normalized) return;
    const id = createId("collection");
    const itemIds = saveItemId ? [saveItemId] : [];
    const collection: Collection = {
      id,
      title: normalized,
      description: description.trim() || "把值得留下的内容整理在一起。",
      itemIds,
      tone: TONES[data.collections.length % TONES.length],
      owned: true,
      curator: "我",
      updatedLabel: "刚刚",
    };
    setData((current) => ({
      ...current,
      collections: [...current.collections, collection],
      items: current.items.map((item) =>
        saveItemId && item.id === saveItemId
          ? { ...item, collectionIds: [...item.collectionIds, id] }
          : item,
      ),
    }));
    setCreateOpen(false);
    setSaveItemId(null);
    showToast({ message: `已创建「${normalized}」` });
  }

  function requestRemoveCollection(collection: Collection) {
    setOpenCollectionId(null);
    setConfirmState({
      title: `删除「${collection.title}」？`,
      description: "合集会被删除，原内容和已读状态都会保留。",
      confirmLabel: "删除合集",
      danger: true,
      onConfirm: () => {
        setData((current) => ({
          ...current,
          collections: current.collections.filter((candidate) => candidate.id !== collection.id),
          items: current.items.map((item) => ({
            ...item,
            collectionIds: item.collectionIds.filter((id) => id !== collection.id),
          })),
        }));
        setConfirmState(null);
        showToast({ message: `已删除「${collection.title}」` });
      },
    });
  }

  function toggleSource(sourceId: string) {
    setData((current) => ({
      ...current,
      sources: current.sources.map((source) =>
        source.id === sourceId ? { ...source, enabled: !source.enabled } : source,
      ),
    }));
  }

  function requestRemoveSource(source: Source) {
    setConfirmState({
      title: `移除「${source.name}」？`,
      description: "之后不再获取新内容；已经加入稍后看或合集的内容会保留。",
      confirmLabel: "移除订阅",
      danger: true,
      onConfirm: () => {
        setData((current) => ({
          ...current,
          sources: current.sources.map((candidate) =>
            candidate.id === source.id
              ? { ...candidate, archived: true, enabled: false, unreadCount: 0 }
              : candidate,
          ),
          items: current.items.filter(
            (item) => item.sourceId !== source.id || item.collectionIds.length > 0,
          ),
        }));
        setConfirmState(null);
        showToast({ message: `已移除「${source.name}」` });
      },
    });
  }

  function normalizePreviewItems(source: Source, items: PreviewItem[]) {
    return items.map<ContentItem>((item, index) => ({
      id: `feed-${source.id}-${stableKey(item.upstreamId || item.url || String(index))}`,
      sourceId: source.id,
      title: item.title,
      summary: item.summary || "打开原站查看这条更新。",
      type: item.type,
      url: item.url,
      publishedAt: item.publishedAt,
      publishedLabel: relativeTimeLabel(item.publishedAt),
      dateGroup: dateGroup(item.publishedAt),
      duration: item.duration,
      read: false,
      thumbnailUrl: item.thumbnailUrl,
      tone: source.tone,
      visualLabel:
        item.type === "video" ? "WATCH / NEW" : item.type === "podcast" ? "LISTEN / NEW" : "READ / NEW",
      collectionIds: [],
    }));
  }

  async function fetchPreview(url: string, limit = 12) {
    const response = await fetch("/api/source-preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, limit }),
    });
    const result = (await response.json()) as PreviewResponse;
    if (!result.ok) throw new Error(result.error.message);
    return result;
  }

  async function refreshSources(sourceIds?: string[]) {
    if (syncing) return;
    const candidates = activeSources.filter(
      (source) =>
        source.enabled &&
        Boolean(source.feedUrl) &&
        (!sourceIds || sourceIds.includes(source.id)),
    );

    if (!online) {
      showToast({ message: "当前处于离线状态，仍可查看已保存的内容" });
      return;
    }
    if (!candidates.length) {
      showToast({ message: "暂无可自动刷新的 RSS 来源；B站订阅仍可直接前往查看" });
      return;
    }

    setSyncing(true);
    const results: Array<{ source: Source; preview?: PreviewSuccess; error?: Error }> = [];
    let nextIndex = 0;
    const workerCount = Math.min(3, candidates.length);

    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        while (nextIndex < candidates.length) {
          const source = candidates[nextIndex];
          nextIndex += 1;
          try {
            const preview = await fetchPreview(source.feedUrl ?? source.url);
            results.push({ source, preview });
          } catch (error) {
            results.push({
              source,
              error: error instanceof Error ? error : new Error("更新失败"),
            });
          }
        }
      }),
    );

    const existingUrls = new Set(data.items.map((item) => item.url));
    const prepared = results.map((result) => {
      if (!result.preview || result.preview.mode !== "live") {
        return { ...result, additions: [] as ContentItem[] };
      }
      const normalized = normalizePreviewItems(result.source, result.preview.items);
      const additions = normalized.filter((item) => !existingUrls.has(item.url));
      for (const item of additions) existingUrls.add(item.url);
      return { ...result, additions };
    });
    const totalNew = prepared.reduce((total, result) => total + result.additions.length, 0);

    setData((current) => {
      let items = [...current.items];
      const sourceUpdates = new Map<string, number>();

      for (const result of prepared) {
        if (!result.preview || result.preview.mode !== "live") continue;
        sourceUpdates.set(result.source.id, result.additions.length);
        items = [...result.additions, ...items];
      }

      return {
        ...current,
        items,
        sources: current.sources.map((source) =>
          sourceUpdates.has(source.id)
            ? {
                ...source,
                lastSyncLabel: "刚刚",
                unreadCount: source.unreadCount + (sourceUpdates.get(source.id) ?? 0),
              }
            : source,
        ),
      };
    });

    const failed = results.filter((result) => result.error).length;
    setSyncing(false);
    if (failed) {
      showToast({
        message: `${failed} 个来源更新失败，已保留上次成功获取的内容`,
        actionLabel: "重试",
        onAction: () => void refreshSources(sourceIds),
      });
    } else {
      showToast({
        message: totalNew ? `更新完成，带回 ${totalNew} 条新内容` : "更新完成，暂时没有新内容",
      });
    }
  }

  function subscribeSuggestion(suggestion: SuggestedCollection) {
    const existing = data.collections.find(
      (collection) => collection.id === `followed-${suggestion.id}`,
    );
    if (existing) {
      setData((current) => ({
        ...current,
        collections: current.collections.filter((collection) => collection.id !== existing.id),
      }));
      showToast({ message: `已取消订阅「${suggestion.title}」` });
      return;
    }

    const collection: Collection = {
      id: `followed-${suggestion.id}`,
      title: suggestion.title,
      description: suggestion.description,
      itemIds: [],
      tone: suggestion.tone,
      owned: false,
      curator: suggestion.curator,
      updatedLabel: "3 天前",
      muted: !data.settings.includeCollectionUpdates,
    };
    setData((current) => ({ ...current, collections: [...current.collections, collection] }));
    showToast({
      message: `已订阅「${suggestion.title}」`,
      actionLabel: "查看合集",
      onAction: () => {
        setOpenSuggestionId(null);
        setView("collections");
      },
    });
  }

  function hideSuggestion(suggestion: SuggestedCollection) {
    setData((current) => ({
      ...current,
      settings: {
        ...current.settings,
        hiddenSuggestionIds: [...current.settings.hiddenSuggestionIds, suggestion.id],
      },
    }));
    showToast({
      message: "已在这台设备上隐藏这个合集",
      actionLabel: "撤销",
      onAction: () =>
        setData((current) => ({
          ...current,
          settings: {
            ...current.settings,
            hiddenSuggestionIds: current.settings.hiddenSuggestionIds.filter(
              (id) => id !== suggestion.id,
            ),
          },
        })),
    });
  }

  function removeDemoData() {
    setConfirmState({
      title: "清除示例内容？",
      description: "示例订阅、内容和合集会被移除；你自己添加的数据不会受影响。",
      confirmLabel: "清除示例",
      danger: true,
      onConfirm: () => {
        const demoItemIds = new Set(
          data.items.filter((item) => item.isDemo).map((item) => item.id),
        );
        setData((current) => ({
          ...current,
          sources: current.sources.filter((source) => !source.isDemo),
          items: current.items.filter((item) => !item.isDemo),
          collections: current.collections
            .filter((collection) => !collection.isDemo)
            .map((collection) => ({
              ...collection,
              itemIds: collection.itemIds.filter((id) => !demoItemIds.has(id)),
            })),
          settings: { ...current.settings, welcomeDismissed: true },
        }));
        setConfirmState(null);
        showToast({ message: "示例内容已清除，可以添加你的第一个订阅了" });
      },
    });
  }

  function exportData() {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `our-choice-backup-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    showToast({ message: "本地数据备份已导出" });
  }

  async function importData(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const parsed: unknown = JSON.parse(await file.text());
      if (!isValidImport(parsed)) throw new Error("invalid");
      setData(parsed);
      setSettingsOpen(false);
      showToast({ message: "备份已导入，本地内容恢复完成" });
    } catch {
      showToast({ message: "没有认出这个备份文件，请确认格式后重试" });
    }
  }

  function requestClearAll() {
    setSettingsOpen(false);
    setConfirmState({
      title: "清空这台设备上的全部数据？",
      description: "订阅、合集和已读状态都会被删除。建议先导出一份备份。",
      confirmLabel: "全部清空",
      danger: true,
      onConfirm: () => {
        const empty = cloneDefaultData();
        empty.sources = [];
        empty.items = [];
        empty.collections = [
          {
            id: "collection-later",
            title: "稍后再看",
            description: "暂时放下，但不想错过的内容。",
            itemIds: [],
            tone: "sun",
            owned: true,
            curator: "我",
            updatedLabel: "刚刚",
            isSystem: true,
          },
        ];
        empty.settings.welcomeDismissed = true;
        setData(empty);
        setConfirmState(null);
        setView("today");
        showToast({ message: "本地数据已清空" });
      },
    });
  }

  const todayLabel = new Intl.DateTimeFormat("zh-CN", {
    month: "long",
    day: "numeric",
    weekday: "long",
  }).format(new Date());

  const currentNav = navItems.find((item) => item.id === view) ?? navItems[0];
  const nextFocusItem = inboxItems.find((item) => !item.read);

  return (
    <div className="app-shell" data-hydrated={hydrated ? "true" : "false"}>
      <a className="skip-link" href="#main-content">
        跳到主要内容
      </a>

      <aside className={`sidebar ${mobileMenuOpen ? "is-open" : ""}`}>
        <div className="brand-row">
          <button className="brand" type="button" onClick={() => goTo("today")}>
            <span className="brand-mark" aria-hidden="true">
              <span />
            </span>
            <span className="brand-copy">
              <strong>自选</strong>
              <small>OUR CHOICE</small>
            </span>
          </button>
          <button
            className="mobile-close icon-button"
            type="button"
            aria-label="关闭导航"
            onClick={() => setMobileMenuOpen(false)}
          >
            <X size={20} />
          </button>
        </div>

        <nav className="primary-nav" aria-label="主要导航">
          {navItems.map((item) => {
            const Icon = item.icon;
            const count = item.id === "today" ? unreadCount : item.id === "collections" ? laterCount : 0;
            return (
              <button
                key={item.id}
                className={`nav-item ${view === item.id && !query ? "is-active" : ""}`}
                type="button"
                aria-current={view === item.id && !query ? "page" : undefined}
                onClick={() => goTo(item.id)}
              >
                <Icon size={19} strokeWidth={1.8} />
                <span>{item.label}</span>
                {count > 0 && <span className="nav-count">{count}</span>}
              </button>
            );
          })}
        </nav>

        <div className="sidebar-note">
          <div className="privacy-orb" aria-hidden="true">
            <LockKeyhole size={17} />
          </div>
          <strong>内容选择留在本机</strong>
          <p>订阅、阅读记录和偏好不会上传。</p>
          <button type="button" onClick={() => setSettingsOpen(true)}>
            查看数据与隐私 <ChevronRight size={14} />
          </button>
        </div>

        <button className="settings-link" type="button" onClick={() => setSettingsOpen(true)}>
          <Settings size={18} />
          <span>设置</span>
        </button>
      </aside>

      <div className="app-column">
        <header className="topbar">
          <div className="topbar-context">
            <button
              className="mobile-menu icon-button"
              type="button"
              aria-label="打开导航"
              onClick={() => setMobileMenuOpen(true)}
            >
              <Menu size={21} />
            </button>
            <div>
              <span className="topbar-kicker">你的内容空间</span>
              <strong>{query ? "搜索" : currentNav.label}</strong>
            </div>
          </div>

          <label className="search-box">
            <Search size={18} aria-hidden="true" />
            <span className="sr-only">搜索所有内容</span>
            <input
              ref={searchRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索标题、来源或关键词"
            />
            {query ? (
              <button type="button" aria-label="清除搜索" onClick={() => setQuery("")}>
                <X size={16} />
              </button>
            ) : (
              <kbd>/</kbd>
            )}
          </label>

          <button className="primary-button topbar-add" type="button" onClick={() => setAddOpen(true)}>
            <Plus size={18} />
            <span>添加订阅</span>
          </button>
        </header>

        {!online && (
          <div className="offline-banner" role="status">
            <WifiOff size={16} />
            你已离线，仍可查看已保存的内容；恢复网络后可以继续更新。
          </div>
        )}

        <main id="main-content" className="main-content" tabIndex={-1}>
          {query ? (
            <SearchResults
              query={query}
              items={searchedItems}
              data={data}
              onMarkRead={markReadWithUndo}
              onToggleLater={toggleLater}
              onSave={openSaveDialog}
              laterCollectionId={laterCollection?.id}
            />
          ) : view === "today" ? (
            <TodayView
              data={data}
              items={inboxItems}
              unreadCount={unreadCount}
              todayLabel={todayLabel}
              typeFilter={typeFilter}
              unreadOnly={unreadOnly}
              syncing={syncing}
              laterCollectionId={laterCollection?.id}
              onSetTypeFilter={setTypeFilter}
              onToggleUnread={() => setUnreadOnly((current) => !current)}
              onRefresh={() => void refreshSources()}
              onMarkAll={markAllRead}
              onMarkRead={markReadWithUndo}
              onToggleLater={toggleLater}
              onSave={openSaveDialog}
              onAdd={() => setAddOpen(true)}
              onDiscover={() => goTo("discover")}
              onFocus={() => setFocusOpen(true)}
              onDismissWelcome={() =>
                setData((current) => ({
                  ...current,
                  settings: { ...current.settings, welcomeDismissed: true },
                }))
              }
              onRemoveDemo={removeDemoData}
            />
          ) : view === "subscriptions" ? (
            <SubscriptionsView
              sources={activeSources}
              totalUnread={unreadCount}
              syncing={syncing}
              onAdd={() => setAddOpen(true)}
              onRefresh={() => void refreshSources()}
              onRefreshSource={(id) => void refreshSources([id])}
              onToggleSource={toggleSource}
              onRemoveSource={requestRemoveSource}
            />
          ) : view === "collections" ? (
            <CollectionsView
              collections={data.collections}
              items={data.items}
              onCreate={() => setCreateOpen(true)}
              onOpen={setOpenCollectionId}
              onDiscover={() => goTo("discover")}
            />
          ) : (
            <DiscoverView
              mode={discoverMode}
              localMatching={data.settings.localMatching}
              hiddenIds={data.settings.hiddenSuggestionIds}
              followedIds={new Set(
                data.collections
                  .filter((collection) => !collection.owned)
                  .map((collection) => collection.id.replace(/^followed-/, "")),
              )}
              onSetMode={setDiscoverMode}
              onToggleMatching={() =>
                setData((current) => ({
                  ...current,
                  settings: {
                    ...current.settings,
                    localMatching: !current.settings.localMatching,
                  },
                }))
              }
              onOpen={setOpenSuggestionId}
              onSubscribe={subscribeSuggestion}
              onHide={hideSuggestion}
            />
          )}
        </main>
      </div>

      <nav className="mobile-bottom-nav" aria-label="移动端主要导航">
        {navItems.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              className={view === item.id && !query ? "is-active" : ""}
              type="button"
              aria-current={view === item.id && !query ? "page" : undefined}
              onClick={() => goTo(item.id)}
            >
              <Icon size={20} />
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>

      {addOpen && (
        <AddSubscriptionModal
          existingSources={activeSources}
          sourceCount={data.sources.length}
          onClose={() => setAddOpen(false)}
          onFetchPreview={fetchPreview}
          onConfirm={(preview, name, includeRecent) => {
            const tone = TONES[data.sources.length % TONES.length];
            const sourceId = createId("source");
            const source: Source = {
              id: sourceId,
              name: name.trim() || preview.source.title,
              description:
                preview.source.description ||
                (preview.mode === "live" ? "通过 RSS 获取的新内容" : "B站链接订阅"),
              platform: preview.source.kind === "bilibili" ? "bilibili" : "rss",
              url:
                preview.source.siteUrl ||
                preview.source.profileUrl ||
                preview.source.feedUrl ||
                "#",
              feedUrl: preview.source.feedUrl,
              initials: (name.trim() || preview.source.title).slice(0, 1),
              tone,
              enabled: true,
              lastSyncLabel: preview.mode === "live" ? "刚刚" : "链接模式",
              unreadCount: preview.mode === "live" && includeRecent ? Math.min(3, preview.items.length) : 0,
            };
            const items =
              preview.mode === "live" && includeRecent
                ? normalizePreviewItems(source, preview.items.slice(0, 3))
                : [];
            setData((current) => ({
              ...current,
              sources: [...current.sources, source],
              items: [...items, ...current.items],
            }));
            setAddOpen(false);
            setView("subscriptions");
            showToast({
              message:
                preview.mode === "live"
                  ? `已订阅「${source.name}」，带回 ${items.length} 条最近内容`
                  : `已以链接模式保存「${source.name}」`,
            });
          }}
        />
      )}

      {createOpen && (
        <CreateCollectionModal
          hasPendingItem={Boolean(saveItemId)}
          onClose={() => {
            setCreateOpen(false);
            setSaveItemId(null);
          }}
          onCreate={createCollection}
        />
      )}

      {saveItemId && !createOpen && (
        <SaveItemModal
          item={data.items.find((item) => item.id === saveItemId)}
          collections={data.collections.filter((collection) => collection.owned)}
          onClose={() => setSaveItemId(null)}
          onToggle={(collectionId) => toggleItemInCollection(saveItemId, collectionId)}
          onCreate={() => setCreateOpen(true)}
        />
      )}

      {openCollectionId && (
        <CollectionDetailModal
          collection={data.collections.find((collection) => collection.id === openCollectionId)}
          data={data}
          onClose={() => setOpenCollectionId(null)}
          onRemove={requestRemoveCollection}
          onOpenItem={(item) => markReadWithUndo(item.id)}
          onRemoveItem={(itemId, collectionId) => toggleItemInCollection(itemId, collectionId)}
        />
      )}

      {openSuggestionId && (
        <SuggestionModal
          suggestion={suggestedCollections.find((item) => item.id === openSuggestionId)}
          followed={data.collections.some(
            (collection) => collection.id === `followed-${openSuggestionId}`,
          )}
          onClose={() => setOpenSuggestionId(null)}
          onSubscribe={subscribeSuggestion}
        />
      )}

      {settingsOpen && (
        <SettingsModal
          data={data}
          onClose={() => setSettingsOpen(false)}
          onExport={exportData}
          onImport={() => importRef.current?.click()}
          onClear={requestClearAll}
          onToggleMatching={() =>
            setData((current) => ({
              ...current,
              settings: {
                ...current.settings,
                localMatching: !current.settings.localMatching,
              },
            }))
          }
          onToggleCollectionUpdates={() =>
            setData((current) => ({
              ...current,
              settings: {
                ...current.settings,
                includeCollectionUpdates: !current.settings.includeCollectionUpdates,
              },
            }))
          }
        />
      )}

      {focusOpen && (
        <FocusModal
          item={nextFocusItem}
          source={nextFocusItem ? sourceForItem(data, nextFocusItem) : undefined}
          remaining={inboxItems.filter((item) => !item.read).length}
          onClose={() => setFocusOpen(false)}
          onMarkRead={setItemRead}
          onDiscover={() => {
            setFocusOpen(false);
            goTo("discover");
          }}
        />
      )}

      {confirmState && (
        <ConfirmModal state={confirmState} onClose={() => setConfirmState(null)} />
      )}

      <input
        ref={importRef}
        className="sr-only"
        type="file"
        accept="application/json,.json"
        onChange={(event) => void importData(event)}
      />

      <div className={`toast ${toast ? "is-visible" : ""}`} aria-live="polite" aria-atomic="true">
        {toast && (
          <>
            <span className="toast-mark" aria-hidden="true">
              <Check size={15} />
            </span>
            <span>{toast.message}</span>
            {toast.actionLabel && toast.onAction && (
              <button
                type="button"
                onClick={() => {
                  toast.onAction?.();
                  setToast(null);
                }}
              >
                {toast.actionLabel}
              </button>
            )}
            <button className="toast-close" type="button" aria-label="关闭提示" onClick={() => setToast(null)}>
              <X size={15} />
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function TodayView({
  data,
  items,
  unreadCount,
  todayLabel,
  typeFilter,
  unreadOnly,
  syncing,
  laterCollectionId,
  onSetTypeFilter,
  onToggleUnread,
  onRefresh,
  onMarkAll,
  onMarkRead,
  onToggleLater,
  onSave,
  onAdd,
  onDiscover,
  onFocus,
  onDismissWelcome,
  onRemoveDemo,
}: {
  data: AppData;
  items: ContentItem[];
  unreadCount: number;
  todayLabel: string;
  typeFilter: TypeFilter;
  unreadOnly: boolean;
  syncing: boolean;
  laterCollectionId?: string;
  onSetTypeFilter: (type: TypeFilter) => void;
  onToggleUnread: () => void;
  onRefresh: () => void;
  onMarkAll: () => void;
  onMarkRead: (id: string) => void;
  onToggleLater: (id: string) => void;
  onSave: (id: string) => void;
  onAdd: () => void;
  onDiscover: () => void;
  onFocus: () => void;
  onDismissWelcome: () => void;
  onRemoveDemo: () => void;
}) {
  const filteredItems = items.filter(
    (item) =>
      (typeFilter === "all" || item.type === typeFilter) && (!unreadOnly || !item.read),
  );
  const groups = ["今天", "昨天", "更早"] as const;
  const hasDemo = data.items.some((item) => item.isDemo);

  return (
    <>
      <section className="page-heading today-heading">
        <div>
          <p className="eyebrow" suppressHydrationWarning>
            {todayLabel}
          </p>
          <h1>今天，只看你主动选择的</h1>
          <p>
            {unreadCount > 0
              ? `${unreadCount} 条新内容，来自你信任的订阅。这里没有偷偷混进来的推荐。`
              : "今天的收件箱已经安静下来。没有下一页也没关系。"}
          </p>
        </div>
        <div className="heading-actions">
          {unreadCount > 0 && (
            <button className="quiet-button" type="button" onClick={onFocus}>
              <CirclePlay size={17} /> 安静阅读
            </button>
          )}
          <button className="quiet-button" type="button" onClick={onMarkAll}>
            <CheckCheck size={17} /> 全部读过
          </button>
          <button className="secondary-button" type="button" onClick={onRefresh} disabled={syncing}>
            <RefreshCw className={syncing ? "is-spinning" : ""} size={17} />
            {syncing ? "正在更新" : "更新内容"}
          </button>
        </div>
      </section>

      {hasDemo && !data.settings.welcomeDismissed && (
        <section className="welcome-card">
          <div className="welcome-emblem" aria-hidden="true">
            <span>选</span>
          </div>
          <div>
            <span className="section-label">欢迎来到自选</span>
            <h2>这里没有替你做主的信息流。</h2>
            <p>我们放入了一组示例内容，帮助你先感受有限、安静的订阅收件箱。</p>
            <div className="welcome-actions">
              <button className="primary-button" type="button" onClick={onAdd}>
                <Plus size={17} /> 添加我的订阅
              </button>
              <button className="text-button" type="button" onClick={onRemoveDemo}>
                清除示例内容
              </button>
            </div>
          </div>
          <button className="icon-button welcome-close" type="button" aria-label="收起欢迎提示" onClick={onDismissWelcome}>
            <X size={18} />
          </button>
        </section>
      )}

      {items.length > 0 && (
        <div className="filter-row" aria-label="内容筛选">
          <div className="filter-tabs" role="group" aria-label="按内容类型筛选">
            {(
              [
                ["all", "全部"],
                ["video", "视频"],
                ["podcast", "播客"],
                ["article", "文章"],
              ] as Array<[TypeFilter, string]>
            ).map(([id, label]) => (
              <button
                key={id}
                className={typeFilter === id ? "is-active" : ""}
                type="button"
                aria-pressed={typeFilter === id}
                onClick={() => onSetTypeFilter(id)}
              >
                {label}
              </button>
            ))}
          </div>
          <button
            className={`filter-toggle ${unreadOnly ? "is-active" : ""}`}
            type="button"
            aria-pressed={unreadOnly}
            onClick={onToggleUnread}
          >
            <span className="status-dot" /> 只看未读
          </button>
        </div>
      )}

      {filteredItems.length ? (
        groups.map((group) => {
          const groupItems = filteredItems.filter((item) => item.dateGroup === group);
          if (!groupItems.length) return null;
          return (
            <section className="content-section" key={group} aria-labelledby={`group-${group}`}>
              <div className="section-heading">
                <h2 id={`group-${group}`}>{group}</h2>
                <span>{groupItems.length} 条</span>
              </div>
              <div className="content-grid">
                {groupItems.map((item) => (
                  <ContentCard
                    key={item.id}
                    item={item}
                    source={sourceForItem(data, item)}
                    savedForLater={Boolean(laterCollectionId && item.collectionIds.includes(laterCollectionId))}
                    onMarkRead={() => onMarkRead(item.id)}
                    onToggleLater={() => onToggleLater(item.id)}
                    onSave={() => onSave(item.id)}
                  />
                ))}
              </div>
            </section>
          );
        })
      ) : items.length ? (
        <EmptyState
          icon={SlidersHorizontal}
          title="这个筛选下没有内容"
          description="换一个类型，或者关闭“只看未读”试试。"
          actionLabel="显示全部内容"
          onAction={() => {
            onSetTypeFilter("all");
            if (unreadOnly) onToggleUnread();
          }}
        />
      ) : (
        <EmptyState
          icon={Inbox}
          title="这里还没有内容"
          description="添加一个你已经信任的来源，今日只会出现你主动订阅的内容。"
          actionLabel="添加第一个订阅"
          onAction={onAdd}
          secondaryLabel="去发现逛一小圈"
          onSecondary={onDiscover}
        />
      )}

      {items.length > 0 && unreadCount === 0 && (
        <section className="done-card">
          <span className="done-mark" aria-hidden="true">
            <Check size={24} />
          </span>
          <div>
            <h2>今天就到这里</h2>
            <p>你已经看完所有新内容。没有下一页也没关系。</p>
          </div>
          <button className="quiet-button" type="button" onClick={onDiscover}>
            去发现逛一小圈 <ArrowRight size={16} />
          </button>
        </section>
      )}
    </>
  );
}

function SearchResults({
  query,
  items,
  data,
  onMarkRead,
  onToggleLater,
  onSave,
  laterCollectionId,
}: {
  query: string;
  items: ContentItem[];
  data: AppData;
  onMarkRead: (id: string) => void;
  onToggleLater: (id: string) => void;
  onSave: (id: string) => void;
  laterCollectionId?: string;
}) {
  return (
    <>
      <section className="page-heading compact-heading">
        <div>
          <p className="eyebrow">搜索所有已保存内容</p>
          <h1>“{query}”</h1>
          <p>{items.length ? `找到 ${items.length} 条相关内容` : "没有找到相关结果"}</p>
        </div>
      </section>
      {items.length ? (
        <div className="content-grid search-results-grid">
          {items.map((item) => (
            <ContentCard
              key={item.id}
              item={item}
              source={sourceForItem(data, item)}
              savedForLater={Boolean(laterCollectionId && item.collectionIds.includes(laterCollectionId))}
              onMarkRead={() => onMarkRead(item.id)}
              onToggleLater={() => onToggleLater(item.id)}
              onSave={() => onSave(item.id)}
            />
          ))}
        </div>
      ) : (
        <EmptyState
          icon={Search}
          title="没有找到相关内容"
          description="试试更短的关键词，或者搜索来源名称。"
        />
      )}
    </>
  );
}

function ContentCard({
  item,
  source,
  savedForLater,
  onMarkRead,
  onToggleLater,
  onSave,
}: {
  item: ContentItem;
  source?: Source;
  savedForLater: boolean;
  onMarkRead: () => void;
  onToggleLater: () => void;
  onSave: () => void;
}) {
  const [imageFailed, setImageFailed] = useState(false);
  const TypeIcon = item.type === "video" ? Play : item.type === "podcast" ? Headphones : FileText;
  const platform = source?.platform ? platformLabels[source.platform] : "已保存来源";

  return (
    <article className={`content-card ${item.read ? "is-read" : ""}`}>
      <a
        className={`content-visual tone-${item.tone}`}
        href={item.url}
        target="_blank"
        rel="noopener noreferrer"
        onClick={onMarkRead}
        aria-label={`${item.title}，去${platform}查看`}
      >
        {item.thumbnailUrl && !imageFailed && (
          <img
            src={item.thumbnailUrl}
            alt=""
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={() => setImageFailed(true)}
          />
        )}
        <span className="visual-grid" aria-hidden="true" />
        <span className="visual-sun" aria-hidden="true" />
        <span className="visual-line" aria-hidden="true" />
        <span className="visual-label">{item.visualLabel}</span>
        <span className="type-badge">
          <TypeIcon size={12} fill={item.type === "video" ? "currentColor" : "none"} />
          {contentTypeLabels[item.type]}
        </span>
        <span className="duration-badge">{item.duration}</span>
      </a>

      <div className="card-body">
        <div className="source-line">
          <SourceAvatar source={source} size="small" />
          <span>{source?.name ?? "已保存来源"}</span>
          <span className="source-separator">·</span>
          <time dateTime={item.publishedAt}>{item.publishedLabel}</time>
          {!item.read && <span className="unread-label">未读</span>}
        </div>
        <a
          className="card-title"
          href={item.url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={onMarkRead}
        >
          {item.title}
        </a>
        <p className="card-summary">{item.summary}</p>
        <div className="card-actions">
          <a
            className="open-link"
            href={item.url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={onMarkRead}
          >
            去{platform} <ExternalLink size={14} />
          </a>
          <div>
            <button
              className={savedForLater ? "is-active" : ""}
              type="button"
              aria-label={savedForLater ? "从稍后再看移除" : "加入稍后再看"}
              aria-pressed={savedForLater}
              onClick={onToggleLater}
            >
              <Bookmark size={17} fill={savedForLater ? "currentColor" : "none"} />
            </button>
            <button type="button" aria-label="加入合集" onClick={onSave}>
              <FolderPlus size={17} />
            </button>
          </div>
        </div>
      </div>
    </article>
  );
}

function SubscriptionsView({
  sources,
  totalUnread,
  syncing,
  onAdd,
  onRefresh,
  onRefreshSource,
  onToggleSource,
  onRemoveSource,
}: {
  sources: Source[];
  totalUnread: number;
  syncing: boolean;
  onAdd: () => void;
  onRefresh: () => void;
  onRefreshSource: (id: string) => void;
  onToggleSource: (id: string) => void;
  onRemoveSource: (source: Source) => void;
}) {
  const liveCount = sources.filter((source) => source.enabled).length;
  const rssCount = sources.filter((source) => source.feedUrl).length;

  return (
    <>
      <section className="page-heading compact-heading">
        <div>
          <p className="eyebrow">你的来源</p>
          <h1>订阅</h1>
          <p>只有你主动选择的来源，才会进入今日。</p>
        </div>
        <div className="heading-actions">
          <button className="secondary-button" type="button" onClick={onRefresh} disabled={syncing}>
            <RefreshCw className={syncing ? "is-spinning" : ""} size={17} />
            {syncing ? "正在更新" : "更新全部"}
          </button>
          <button className="primary-button" type="button" onClick={onAdd}>
            <Plus size={17} /> 添加订阅
          </button>
        </div>
      </section>

      {sources.length ? (
        <>
          <section className="subscription-summary" aria-label="订阅概览">
            <div>
              <strong>{sources.length}</strong>
              <span>全部来源</span>
            </div>
            <div>
              <strong>{liveCount}</strong>
              <span>正在更新</span>
            </div>
            <div>
              <strong>{rssCount}</strong>
              <span>可自动同步</span>
            </div>
            <div>
              <strong>{totalUnread}</strong>
              <span>未读内容</span>
            </div>
          </section>

          <section className="source-list" aria-label="订阅来源列表">
            <div className="list-header" aria-hidden="true">
              <span>来源</span>
              <span>状态</span>
              <span>最近更新</span>
              <span>操作</span>
            </div>
            {sources.map((source) => (
              <article className={`source-row ${!source.enabled ? "is-paused" : ""}`} key={source.id}>
                <div className="source-main">
                  <SourceAvatar source={source} />
                  <div>
                    <strong>{source.name}</strong>
                    <p>{source.description}</p>
                    <span className="mobile-source-meta">
                      {platformLabels[source.platform]} · {source.lastSyncLabel}
                    </span>
                  </div>
                </div>
                <div className="source-status">
                  <span className={`platform-pill platform-${source.platform}`}>
                    {platformLabels[source.platform]}
                  </span>
                  {source.enabled ? (
                    source.feedUrl ? (
                      <span className="status-text success"><span /> 自动同步</span>
                    ) : (
                      <span className="status-text link"><span /> 链接模式</span>
                    )
                  ) : (
                    <span className="status-text paused"><span /> 已暂停</span>
                  )}
                </div>
                <div className="source-updated">
                  <span>{source.lastSyncLabel}</span>
                  {source.unreadCount > 0 && <strong>新增 {source.unreadCount} 条</strong>}
                </div>
                <div className="source-actions">
                  {source.feedUrl ? (
                    <button type="button" aria-label={`更新 ${source.name}`} onClick={() => onRefreshSource(source.id)}>
                      <RefreshCw size={17} />
                    </button>
                  ) : (
                    <a href={source.url} target="_blank" rel="noopener noreferrer" aria-label={`前往 ${source.name}`}>
                      <ExternalLink size={17} />
                    </a>
                  )}
                  <button
                    type="button"
                    aria-label={source.enabled ? `暂停 ${source.name}` : `恢复 ${source.name}`}
                    onClick={() => onToggleSource(source.id)}
                  >
                    {source.enabled ? <Pause size={17} /> : <Play size={17} />}
                  </button>
                  <button className="danger-icon" type="button" aria-label={`移除 ${source.name}`} onClick={() => onRemoveSource(source)}>
                    <Trash2 size={17} />
                  </button>
                </div>
              </article>
            ))}
          </section>

          <p className="list-footnote">
            <LockKeyhole size={14} /> RSS 由本地站点按需读取；B站来源使用链接模式，不依赖非公开接口。
          </p>
        </>
      ) : (
        <EmptyState
          icon={Rss}
          title="还没有订阅"
          description="粘贴一个 RSS 或 B站主页，从你已经信任的来源开始。"
          actionLabel="添加第一个订阅"
          onAction={onAdd}
        />
      )}
    </>
  );
}

function CollectionsView({
  collections,
  items,
  onCreate,
  onOpen,
  onDiscover,
}: {
  collections: Collection[];
  items: ContentItem[];
  onCreate: () => void;
  onOpen: (id: string) => void;
  onDiscover: () => void;
}) {
  const owned = collections.filter((collection) => collection.owned);
  const followed = collections.filter((collection) => !collection.owned);

  return (
    <>
      <section className="page-heading compact-heading">
        <div>
          <p className="eyebrow">你的筛选与整理</p>
          <h1>合集</h1>
          <p>把真正值得留下的内容，整理成一条可以重访的路径。</p>
        </div>
        <button className="primary-button" type="button" onClick={onCreate}>
          <Plus size={17} /> 新建合集
        </button>
      </section>

      <section className="collection-section" aria-labelledby="owned-collections">
        <div className="section-heading">
          <h2 id="owned-collections">我创建的</h2>
          <span>{owned.length} 个</span>
        </div>
        {owned.length ? (
          <div className="collection-grid">
            {owned.map((collection) => (
              <CollectionCard
                key={collection.id}
                collection={collection}
                items={items.filter((item) => collection.itemIds.includes(item.id))}
                onOpen={() => onOpen(collection.id)}
              />
            ))}
            <button className="new-collection-card" type="button" onClick={onCreate}>
              <span><Plus size={22} /></span>
              <strong>新建一个合集</strong>
              <small>为下一次相遇留一条线索</small>
            </button>
          </div>
        ) : (
          <EmptyState
            icon={Library}
            title="还没有合集"
            description="下次遇到值得留下的内容，把它们整理到一起。"
            actionLabel="新建合集"
            onAction={onCreate}
          />
        )}
      </section>

      <section className="collection-section followed-section" aria-labelledby="followed-collections">
        <div className="section-heading">
          <h2 id="followed-collections">我订阅的</h2>
          <button className="text-button" type="button" onClick={onDiscover}>
            发现更多 <ArrowRight size={15} />
          </button>
        </div>
        {followed.length ? (
          <div className="collection-grid">
            {followed.map((collection) => (
              <CollectionCard
                key={collection.id}
                collection={collection}
                items={[]}
                onOpen={() => onOpen(collection.id)}
              />
            ))}
          </div>
        ) : (
          <div className="inline-empty">
            <div className="inline-empty-icon"><Compass size={20} /></div>
            <div>
              <strong>还没有订阅别人的合集</strong>
              <p>发现页与今日分开，只有你主动订阅的合集才会持续更新。</p>
            </div>
            <button className="quiet-button" type="button" onClick={onDiscover}>
              去发现看看 <ArrowRight size={15} />
            </button>
          </div>
        )}
      </section>
    </>
  );
}

function CollectionCard({
  collection,
  items,
  onOpen,
}: {
  collection: Collection;
  items: ContentItem[];
  onOpen: () => void;
}) {
  const tiles = items.slice(0, 4);
  return (
    <button className="collection-card" type="button" onClick={onOpen} aria-label={`打开合集 ${collection.title}`}>
      <span className="collection-bookmark" aria-hidden="true" />
      <span className={`collection-collage tone-${collection.tone}`} aria-hidden="true">
        {tiles.length ? (
          Array.from({ length: 4 }, (_, index) => {
            const item = tiles[index % tiles.length];
            return (
              <span className={`collage-tile tone-${item.tone}`} key={`${item.id}-${index}`}>
                <small>{item.visualLabel.split("/")[0]}</small>
              </span>
            );
          })
        ) : (
          <>
            <span className="empty-collage-shape one" />
            <span className="empty-collage-shape two" />
            <span className="empty-collage-copy">{collection.title.slice(0, 2)}</span>
          </>
        )}
      </span>
      <span className="collection-card-body">
        <span className="collection-owner">
          {collection.owned ? "我的合集" : `由 ${collection.curator} 整理`}
          {!collection.owned && <span>已订阅</span>}
        </span>
        <strong>{collection.title}</strong>
        <p>{collection.description}</p>
        <span className="collection-meta">
          {collection.itemIds.length} 条内容 · {collection.updatedLabel}更新
          <ChevronRight size={16} />
        </span>
      </span>
    </button>
  );
}

function DiscoverView({
  mode,
  localMatching,
  hiddenIds,
  followedIds,
  onSetMode,
  onToggleMatching,
  onOpen,
  onSubscribe,
  onHide,
}: {
  mode: DiscoverMode;
  localMatching: boolean;
  hiddenIds: string[];
  followedIds: Set<string>;
  onSetMode: (mode: DiscoverMode) => void;
  onToggleMatching: () => void;
  onOpen: (id: string) => void;
  onSubscribe: (suggestion: SuggestedCollection) => void;
  onHide: (suggestion: SuggestedCollection) => void;
}) {
  const candidates = suggestedCollections.filter(
    (item) => item.distance === mode && !hiddenIds.includes(item.id),
  );

  return (
    <>
      <section className="discover-hero">
        <div className="discover-copy">
          <span className="section-label">本地发现</span>
          <h1>发现新视角，不交出浏览轨迹</h1>
          <p>扩圈的单位是由人整理的合集，不是热榜。匹配只在这台设备上完成，推荐不会混入今日。</p>
          <div className="privacy-points">
            <span><ShieldCheck size={16} /> 不上传订阅列表</span>
            <span><LockKeyhole size={16} /> 不记录浏览画像</span>
          </div>
        </div>
        <div className="discover-orbit" aria-hidden="true">
          <span className="orbit-core">你</span>
          <span className="orbit-dot dot-one">技</span>
          <span className="orbit-dot dot-two">人</span>
          <span className="orbit-dot dot-three">城</span>
          <span className="orbit-line line-one" />
          <span className="orbit-line line-two" />
        </div>
      </section>

      <section className="matching-control">
        <div>
          <Sparkles size={19} />
          <div>
            <strong>设备内兴趣匹配</strong>
            <p>{localMatching ? "已开启 · 只读取本地主题标签" : "已关闭 · 显示编辑精选"}</p>
          </div>
        </div>
        <Toggle checked={localMatching} label="设备内兴趣匹配" onChange={onToggleMatching} />
      </section>

      <div className="discover-tabs" role="tablist" aria-label="探索尺度">
        {(
          [
            ["near", "与我相近", "延续已有主题"],
            ["step", "跨出一步", "熟悉里带一点陌生"],
            ["random", "随便逛逛", "暂时放下兴趣权重"],
          ] as Array<[DiscoverMode, string, string]>
        ).map(([id, label, helper]) => (
          <button
            key={id}
            className={mode === id ? "is-active" : ""}
            type="button"
            role="tab"
            aria-selected={mode === id}
            onClick={() => onSetMode(id)}
          >
            <strong>{label}</strong>
            <span>{helper}</span>
          </button>
        ))}
      </div>

      <section className="discovery-grid" aria-label="推荐合集">
        {candidates.length ? (
          candidates.map((suggestion) => (
            <article className="discovery-card" key={suggestion.id}>
              <button
                className={`discovery-cover tone-${suggestion.tone}`}
                type="button"
                onClick={() => onOpen(suggestion.id)}
                aria-label={`查看合集 ${suggestion.title}`}
              >
                <span className="discovery-number">{String(suggestion.itemCount).padStart(2, "0")}</span>
                <span className="discovery-rule" />
                <span className="discovery-cover-copy">CURATED<br />BY PEOPLE</span>
                <span className="discovery-tags">{suggestion.tags.slice(0, 2).join(" / ")}</span>
              </button>
              <div className="discovery-card-body">
                <div className="curator-line">
                  <span className="curator-avatar">{suggestion.curator.slice(0, 1)}</span>
                  <span>由 {suggestion.curator} 整理</span>
                  <span>·</span>
                  <span>{suggestion.itemCount} 条</span>
                </div>
                <button className="discovery-title" type="button" onClick={() => onOpen(suggestion.id)}>
                  {suggestion.title}
                </button>
                <p>{suggestion.description}</p>
                <div className="reason-box">
                  <Sparkles size={14} />
                  <span><strong>推荐原因：</strong>{suggestion.reason}</span>
                </div>
                <div className="discovery-actions">
                  <button
                    className={followedIds.has(suggestion.id) ? "secondary-button is-subscribed" : "primary-button"}
                    type="button"
                    onClick={() => onSubscribe(suggestion)}
                  >
                    {followedIds.has(suggestion.id) ? <Check size={16} /> : <Plus size={16} />}
                    {followedIds.has(suggestion.id) ? "已订阅" : "订阅合集"}
                  </button>
                  <button className="text-button muted-action" type="button" onClick={() => onHide(suggestion)}>
                    不感兴趣
                  </button>
                </div>
              </div>
            </article>
          ))
        ) : (
          <EmptyState
            icon={Compass}
            title="这个方向暂时逛完了"
            description="换一个探索尺度，或者恢复之前隐藏的推荐。"
          />
        )}
      </section>

      <p className="discovery-footnote">
        获取内容时，来源站点仍会收到正常的网络请求；你的订阅列表和阅读记录不会随请求上传。
      </p>
    </>
  );
}

function Modal({
  title,
  description,
  onClose,
  children,
  size = "medium",
  className = "",
}: {
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  size?: "small" | "medium" | "large" | "drawer" | "focus";
  className?: string;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useMemo(() => createId("dialog-title"), []);
  const descriptionId = useMemo(() => createId("dialog-description"), []);

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    const focusable = dialog?.querySelector<HTMLElement>(
      'button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    focusable?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    function handleKeydown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !dialog) return;
      const controls = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (!controls.length) return;
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeydown);
    return () => {
      document.removeEventListener("keydown", handleKeydown);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, [onClose]);

  return (
    <div className={`modal-layer modal-${size} ${className}`} role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <div
        ref={dialogRef}
        className="modal-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
      >
        <div className="modal-header">
          <div>
            <h2 id={titleId}>{title}</h2>
            {description && <p id={descriptionId}>{description}</p>}
          </div>
          <button className="icon-button" type="button" aria-label="关闭" onClick={onClose}>
            <X size={20} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function AddSubscriptionModal({
  existingSources,
  sourceCount,
  onClose,
  onFetchPreview,
  onConfirm,
}: {
  existingSources: Source[];
  sourceCount: number;
  onClose: () => void;
  onFetchPreview: (url: string, limit?: number) => Promise<PreviewSuccess>;
  onConfirm: (preview: PreviewSuccess, name: string, includeRecent: boolean) => void;
}) {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<PreviewSuccess | null>(null);
  const [name, setName] = useState("");
  const [includeRecent, setIncludeRecent] = useState(true);

  async function identify() {
    setError("");
    setPreview(null);
    const trimmed = url.trim();
    if (!trimmed) {
      setError("请先粘贴一个 B站主页、网站或 RSS 地址。");
      return;
    }
    const duplicate = existingSources.find(
      (source) => source.url === trimmed || source.feedUrl === trimmed,
    );
    if (duplicate) {
      setError(`你已经订阅「${duplicate.name}」了。`);
      return;
    }
    setLoading(true);
    try {
      const result = await onFetchPreview(trimmed, 12);
      setPreview(result);
      setName(result.source.title);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "暂时没认出这个地址，请重试。");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal
      title="添加订阅"
      description="粘贴一个你已经信任的来源。链接只用于识别与按需更新。"
      onClose={onClose}
      size="medium"
    >
      <div className="modal-content add-source-content">
        <label className="field-label" htmlFor="source-url">订阅地址</label>
        <div className={`url-field ${error ? "has-error" : ""}`}>
          <Link2 size={18} />
          <input
            id="source-url"
            value={url}
            onChange={(event) => {
              setUrl(event.target.value);
              setError("");
              setPreview(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") void identify();
            }}
            placeholder="粘贴 B站主页、网站或 RSS 地址"
            autoComplete="url"
            inputMode="url"
          />
          {url && (
            <button type="button" aria-label="清空地址" onClick={() => setUrl("")}>
              <X size={16} />
            </button>
          )}
        </div>
        {error && <p className="field-error" role="alert">{error}</p>}

        {!preview && (
          <div className="supported-sources">
            <div>
              <span className="source-support-icon bilibili-mark">B</span>
              <div>
                <strong>B站主页</strong>
                <p>以链接模式保存，随时前往查看更新</p>
              </div>
            </div>
            <div>
              <span className="source-support-icon"><Rss size={18} /></span>
              <div>
                <strong>RSS / 播客</strong>
                <p>自动识别并带回最新内容预览</p>
              </div>
            </div>
          </div>
        )}

        {loading && (
          <div className="identify-state" role="status" aria-live="polite">
            <span className="identify-spinner" />
            <div>
              <strong>正在识别这个订阅源…</strong>
              <p>通常只需要几秒钟</p>
            </div>
          </div>
        )}

        {preview && (
          <div className="source-preview">
            <div className="preview-success-line">
              <span><Check size={15} /></span>
              {preview.mode === "live" ? "已识别可同步的订阅源" : "已识别 B站链接"}
            </div>
            <div className="preview-source-row">
              <span className={`source-avatar tone-${TONES[sourceCount % TONES.length]}`}>
                {name.slice(0, 1) || "源"}
              </span>
              <div>
                <label className="field-label" htmlFor="source-name">显示名称</label>
                <input id="source-name" value={name} onChange={(event) => setName(event.target.value)} />
                <p>{preview.source.description}</p>
              </div>
            </div>

            {preview.warning && (
              <div className="link-mode-note">
                <Link2 size={16} />
                <p>{preview.warning.message}</p>
              </div>
            )}

            {preview.mode === "live" && (
              <>
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={includeRecent}
                    onChange={(event) => setIncludeRecent(event.target.checked)}
                  />
                  <span><Check size={13} /></span>
                  <div>
                    <strong>将最近 3 条内容带回今日</strong>
                    <p>避免第一次订阅时一下涌入太多旧内容</p>
                  </div>
                </label>
                {preview.items.length > 0 && (
                  <div className="preview-items">
                    {preview.items.slice(0, 3).map((item) => (
                      <div key={item.upstreamId}>
                        <span>{contentTypeLabels[item.type]}</span>
                        <p>{item.title}</p>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>

      <div className="modal-footer">
        <p><LockKeyhole size={13} /> 订阅记录只保存在这台设备</p>
        <div>
          <button className="quiet-button" type="button" onClick={onClose}>取消</button>
          {preview ? (
            <button className="primary-button" type="button" disabled={!name.trim()} onClick={() => onConfirm(preview, name, includeRecent)}>
              <Plus size={16} /> 确认订阅
            </button>
          ) : (
            <button className="primary-button" type="button" disabled={loading || !url.trim()} onClick={() => void identify()}>
              {loading ? <RefreshCw className="is-spinning" size={16} /> : <ArrowRight size={16} />}
              识别订阅源
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}

function CreateCollectionModal({
  hasPendingItem,
  onClose,
  onCreate,
}: {
  hasPendingItem: boolean;
  onClose: () => void;
  onCreate: (title: string, description: string) => void;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  return (
    <Modal
      title="新建合集"
      description={hasPendingItem ? "创建后，这条内容会自动加入合集。" : "给值得重访的内容留一条清晰路径。"}
      onClose={onClose}
      size="small"
    >
      <form
        className="modal-content collection-form"
        onSubmit={(event) => {
          event.preventDefault();
          onCreate(title, description);
        }}
      >
        <label className="field-label" htmlFor="collection-title">合集名称</label>
        <input
          id="collection-title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="例如：数字生活的边界"
          maxLength={42}
        />
        <div className="field-counter">{title.length}/42</div>
        <label className="field-label" htmlFor="collection-description">简介（可选）</label>
        <textarea
          id="collection-description"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="为什么想把这些内容放在一起？"
          rows={4}
          maxLength={160}
        />
        <div className="private-default-note">
          <LockKeyhole size={16} />
          <div>
            <strong>默认仅自己可见</strong>
            <p>首版合集保存在本机，可随时导出备份。</p>
          </div>
        </div>
        <div className="form-actions">
          <button className="quiet-button" type="button" onClick={onClose}>取消</button>
          <button className="primary-button" type="submit" disabled={!title.trim()}>
            创建合集
          </button>
        </div>
      </form>
    </Modal>
  );
}

function SaveItemModal({
  item,
  collections,
  onClose,
  onToggle,
  onCreate,
}: {
  item?: ContentItem;
  collections: Collection[];
  onClose: () => void;
  onToggle: (collectionId: string) => void;
  onCreate: () => void;
}) {
  return (
    <Modal title="加入合集" description={item?.title} onClose={onClose} size="small">
      <div className="modal-content save-list">
        {collections.map((collection) => {
          const checked = Boolean(item?.collectionIds.includes(collection.id));
          return (
            <button key={collection.id} type="button" onClick={() => onToggle(collection.id)}>
              <span className={`collection-mini tone-${collection.tone}`} aria-hidden="true">{collection.title.slice(0, 1)}</span>
              <span>
                <strong>{collection.title}</strong>
                <small>{collection.itemIds.length} 条内容</small>
              </span>
              <span className={`selection-check ${checked ? "is-checked" : ""}`}>
                {checked && <Check size={14} />}
              </span>
            </button>
          );
        })}
        <button className="create-inline" type="button" onClick={onCreate}>
          <span><Plus size={18} /></span>
          <strong>新建合集</strong>
        </button>
      </div>
      <div className="modal-footer simple-footer">
        <button className="primary-button" type="button" onClick={onClose}>完成</button>
      </div>
    </Modal>
  );
}

function CollectionDetailModal({
  collection,
  data,
  onClose,
  onRemove,
  onOpenItem,
  onRemoveItem,
}: {
  collection?: Collection;
  data: AppData;
  onClose: () => void;
  onRemove: (collection: Collection) => void;
  onOpenItem: (item: ContentItem) => void;
  onRemoveItem: (itemId: string, collectionId: string) => void;
}) {
  if (!collection) return null;
  const items = data.items.filter((item) => collection.itemIds.includes(item.id));
  return (
    <Modal title={collection.title} description={collection.description} onClose={onClose} size="drawer" className="collection-drawer">
      <div className="drawer-meta">
        <span>{collection.owned ? "我的合集" : `由 ${collection.curator} 整理`}</span>
        <span>{items.length} 条内容</span>
        <span>{collection.updatedLabel}更新</span>
      </div>
      <div className="drawer-content-list">
        {items.length ? (
          items.map((item, index) => (
            <article key={item.id}>
              <span className={`drawer-index tone-${item.tone}`}>{String(index + 1).padStart(2, "0")}</span>
              <div>
                <span className="drawer-item-meta">
                  {contentTypeLabels[item.type]} · {sourceForItem(data, item)?.name ?? "已保存来源"}
                </span>
                <a href={item.url} target="_blank" rel="noopener noreferrer" onClick={() => onOpenItem(item)}>
                  {item.title}
                </a>
                <p>{item.summary}</p>
              </div>
              {collection.owned && (
                <button type="button" aria-label={`从合集移除 ${item.title}`} onClick={() => onRemoveItem(item.id, collection.id)}>
                  <X size={16} />
                </button>
              )}
            </article>
          ))
        ) : (
          <EmptyState
            icon={Library}
            title={collection.owned ? "这个合集还是空的" : "静态合集快照"}
            description={
              collection.owned
                ? "在内容卡片上选择“加入合集”，从第一条开始。"
                : "首版本地目录不会自动下载别人的内容；未来可通过合集包导入。"
            }
          />
        )}
      </div>
      <div className="drawer-footer">
        <p><LockKeyhole size={13} /> 此合集当前只保存在本机</p>
        <div>
          {collection.owned && !collection.isSystem && (
            <button className="danger-text-button" type="button" onClick={() => onRemove(collection)}>
              <Trash2 size={15} /> 删除合集
            </button>
          )}
          <button className="primary-button" type="button" onClick={onClose}>完成</button>
        </div>
      </div>
    </Modal>
  );
}

function SuggestionModal({
  suggestion,
  followed,
  onClose,
  onSubscribe,
}: {
  suggestion?: SuggestedCollection;
  followed: boolean;
  onClose: () => void;
  onSubscribe: (suggestion: SuggestedCollection) => void;
}) {
  if (!suggestion) return null;
  return (
    <Modal title={suggestion.title} description={suggestion.description} onClose={onClose} size="medium">
      <div className="modal-content suggestion-detail">
        <div className={`suggestion-detail-cover tone-${suggestion.tone}`}>
          <span>{suggestion.itemCount}</span>
          <small>CURATED<br />SELECTIONS</small>
        </div>
        <div className="suggestion-curator">
          <span>{suggestion.curator.slice(0, 1)}</span>
          <div>
            <strong>由 {suggestion.curator} 整理</strong>
            <p>{suggestion.itemCount} 条内容 · 3 天前更新</p>
          </div>
        </div>
        <div className="sample-list">
          <span className="section-label">合集里的几条内容</span>
          {suggestion.sampleTitles.map((title, index) => (
            <div key={title}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <p>{title}</p>
              <ArrowRight size={15} />
            </div>
          ))}
        </div>
        <div className="publish-privacy-note">
          <ShieldCheck size={17} />
          <p>订阅合集不会向整理者公开你的身份、订阅列表或阅读记录。</p>
        </div>
      </div>
      <div className="modal-footer simple-footer">
        <button className="quiet-button" type="button" onClick={onClose}>先不订阅</button>
        <button
          className={followed ? "secondary-button" : "primary-button"}
          type="button"
          onClick={() => onSubscribe(suggestion)}
        >
          {followed ? <Check size={16} /> : <Plus size={16} />}
          {followed ? "已订阅，点击取消" : "订阅这个合集"}
        </button>
      </div>
    </Modal>
  );
}

function SettingsModal({
  data,
  onClose,
  onExport,
  onImport,
  onClear,
  onToggleMatching,
  onToggleCollectionUpdates,
}: {
  data: AppData;
  onClose: () => void;
  onExport: () => void;
  onImport: () => void;
  onClear: () => void;
  onToggleMatching: () => void;
  onToggleCollectionUpdates: () => void;
}) {
  return (
    <Modal title="数据与隐私" description="你拥有这台设备上保存的全部内容。" onClose={onClose} size="medium">
      <div className="modal-content settings-content">
        <section className="local-data-card">
          <div className="local-data-icon"><ShieldCheck size={22} /></div>
          <div>
            <span className="section-label">本地优先</span>
            <h3>你的选择不会成为平台画像</h3>
            <p>订阅、已读状态、合集和发现偏好都保存在浏览器中。自选不要求登录，也不会把这些数据上传。</p>
          </div>
        </section>

        <section className="settings-section">
          <h3>发现偏好</h3>
          <div className="setting-row">
            <div>
              <strong>设备内兴趣匹配</strong>
              <p>使用本地保存的主题为公开合集排序</p>
            </div>
            <Toggle checked={data.settings.localMatching} label="设备内兴趣匹配" onChange={onToggleMatching} />
          </div>
          <div className="setting-row">
            <div>
              <strong>合集更新进入今日</strong>
              <p>仅对你主动订阅的合集生效</p>
            </div>
            <Toggle
              checked={data.settings.includeCollectionUpdates}
              label="合集更新进入今日"
              onChange={onToggleCollectionUpdates}
            />
          </div>
        </section>

        <section className="settings-section">
          <div className="settings-title-row">
            <h3>本地数据</h3>
            <span>{data.sources.filter((source) => !source.archived).length} 个订阅 · {data.collections.length} 个合集</span>
          </div>
          <div className="data-action-grid">
            <button type="button" onClick={onExport}>
              <span><Download size={18} /></span>
              <div><strong>导出备份</strong><p>下载可随时恢复的 JSON 文件</p></div>
              <ChevronRight size={17} />
            </button>
            <button type="button" onClick={onImport}>
              <span><Upload size={18} /></span>
              <div><strong>导入备份</strong><p>从已有备份恢复本地内容</p></div>
              <ChevronRight size={17} />
            </button>
          </div>
          <button className="clear-data-button" type="button" onClick={onClear}>
            <Trash2 size={16} /> 清空这台设备上的全部数据
          </button>
        </section>

        <p className="network-disclosure">
          <LockKeyhole size={14} /> 主动刷新 RSS 时，来源站点仍会收到正常的网络请求。
        </p>
      </div>
    </Modal>
  );
}

function FocusModal({
  item,
  source,
  remaining,
  onClose,
  onMarkRead,
  onDiscover,
}: {
  item?: ContentItem;
  source?: Source;
  remaining: number;
  onClose: () => void;
  onMarkRead: (id: string, read: boolean) => void;
  onDiscover: () => void;
}) {
  return (
    <Modal title="安静阅读" description={item ? `还有 ${remaining} 条未读内容` : "今日收件箱已读完"} onClose={onClose} size="focus">
      {item ? (
        <div className="focus-content">
          <div className={`focus-visual tone-${item.tone}`}>
            <span className="focus-visual-label">{item.visualLabel}</span>
            <span className="focus-circle" />
            <span className="focus-rule" />
          </div>
          <div className="focus-copy">
            <div className="source-line">
              <SourceAvatar source={source} size="small" />
              <span>{source?.name ?? "已保存来源"}</span>
              <span>·</span>
              <span>{contentTypeLabels[item.type]}</span>
              <span>·</span>
              <span>{item.duration}</span>
            </div>
            <h2>{item.title}</h2>
            <p>{item.summary}</p>
            <div className="focus-actions">
              <a className="primary-button" href={item.url} target="_blank" rel="noopener noreferrer" onClick={() => onMarkRead(item.id, true)}>
                去原站查看 <ExternalLink size={16} />
              </a>
              <button className="secondary-button" type="button" onClick={() => onMarkRead(item.id, true)}>
                标为读过，下一条 <ArrowRight size={16} />
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="focus-done">
          <span><Check size={28} /></span>
          <h2>今天就到这里</h2>
          <p>你已经看完所有新内容。关掉页面，也是一种完成。</p>
          <div>
            <button className="quiet-button" type="button" onClick={onClose}>回到今日</button>
            <button className="primary-button" type="button" onClick={onDiscover}>去发现逛一小圈</button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function ConfirmModal({ state, onClose }: { state: ConfirmState; onClose: () => void }) {
  return (
    <Modal title={state.title} description={state.description} onClose={onClose} size="small">
      <div className="confirm-illustration" aria-hidden="true">
        <span><Trash2 size={21} /></span>
      </div>
      <div className="modal-footer simple-footer confirm-footer">
        <button className="quiet-button" type="button" onClick={onClose}>取消</button>
        <button className={state.danger ? "danger-button" : "primary-button"} type="button" onClick={state.onConfirm}>
          {state.confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

function SourceAvatar({ source, size = "regular" }: { source?: Source; size?: "small" | "regular" }) {
  return (
    <span className={`source-avatar tone-${source?.tone ?? "ink"} avatar-${size}`} aria-hidden="true">
      {source?.initials ?? "源"}
    </span>
  );
}

function Toggle({ checked, label, onChange }: { checked: boolean; label: string; onChange: () => void }) {
  return (
    <button
      className={`toggle ${checked ? "is-checked" : ""}`}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onChange}
    >
      <span />
    </button>
  );
}

function EmptyState({
  icon: Icon,
  title,
  description,
  actionLabel,
  onAction,
  secondaryLabel,
  onSecondary,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  actionLabel?: string;
  onAction?: () => void;
  secondaryLabel?: string;
  onSecondary?: () => void;
}) {
  return (
    <div className="empty-state">
      <span className="empty-icon"><Icon size={23} /></span>
      <h2>{title}</h2>
      <p>{description}</p>
      {(actionLabel || secondaryLabel) && (
        <div>
          {actionLabel && onAction && (
            <button className="primary-button" type="button" onClick={onAction}>{actionLabel}</button>
          )}
          {secondaryLabel && onSecondary && (
            <button className="quiet-button" type="button" onClick={onSecondary}>{secondaryLabel}</button>
          )}
        </div>
      )}
    </div>
  );
}
