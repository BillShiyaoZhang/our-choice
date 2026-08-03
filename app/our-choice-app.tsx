"use client";

/* eslint-disable @next/next/no-img-element -- feed images come from user-selected dynamic RSS sources */

import {
  ArrowLeft,
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
  PanelTopOpen,
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
  type Platform,
  type PlatformSession,
  type RssHubManualSubscription,
  type RssHubSelection,
  type Source,
  type SuggestedCollection,
  type View,
  type VisualTone,
} from "./lib/model";

const STORAGE_KEY = "our-choice:state:v1";
const ASSISTANT_STORAGE_KEY = "our-choice:assistant:v1";
const ASSISTANT_HANDOFF_HASH = "#browser-assistant";
const CLIP_SOURCE_ID = "source-browser-clips";
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
  publishedAtReliable?: boolean;
  duration: string;
}

interface PreviewSuccess {
  ok: true;
  mode: "live" | "link-only" | "select";
  source: {
    kind: Platform;
    platformLabel?: string;
    title: string;
    description?: string;
    feedUrl?: string;
    refreshUrl?: string;
    provider?: "rsshub";
    rsshubRoute?: string;
    rsshubSelection?: string;
    rsshubSelections?: RssHubSelection[];
    manualSubscription?: RssHubManualSubscription;
    identityVerified?: boolean;
    routeTitle?: string;
    docsUrl?: string;
    siteUrl?: string;
    profileUrl?: string;
    mid?: string;
    imageUrl?: string;
  };
  items: PreviewItem[];
  options?: Array<{
    id: string;
    title: string;
    description: string;
    docsUrl?: string;
  }>;
  fetchedAt?: string;
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

interface ViewerState {
  kind: "source" | "content";
  url: string;
  title: string;
  sourceName: string;
  platform: string;
  returnScrollY: number;
}

interface AssistantPageCapture {
  url: string;
  title: string;
  description?: string;
  selection?: string;
  siteName?: string;
  imageUrl?: string;
  contentType: ContentType;
}

interface AssistantSourceCandidate {
  url: string;
  name: string;
  externalId?: string;
  imageUrl?: string;
}

type AssistantQueueItem =
  | {
      id: string;
      kind: "clip";
      page: AssistantPageCapture;
      destination: "later" | "collection";
      capturedAt: string;
    }
  | {
      id: string;
      kind: "source";
      candidate: AssistantSourceCandidate;
      capturedAt: string;
    }
  | {
      id: string;
      kind: "follow-batch";
      platform: "bilibili";
      candidates: AssistantSourceCandidate[];
      added: AssistantSourceCandidate[];
      removed: AssistantSourceCandidate[];
      previousCount: number;
      capturedAt: string;
    };

interface AssistantImportSelection {
  clipIds: string[];
  sourceKeys: string[];
  destinations: Record<string, string>;
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

const supportedPlatforms: Array<{ id: Exclude<Platform, "rss" | "podcast" | "web">; label: string }> = [
  { id: "bilibili", label: "B站" },
  { id: "wechat", label: "微信公众号" },
  { id: "zhihu", label: "知乎" },
  { id: "xiaohongshu", label: "小红书" },
  { id: "douyin", label: "抖音" },
  { id: "kuaishou", label: "快手" },
  { id: "weibo", label: "微博" },
  { id: "xiaoyuzhou", label: "小宇宙" },
  { id: "toutiao", label: "今日头条" },
  { id: "baijiahao", label: "百家号" },
  { id: "douban", label: "豆瓣" },
  { id: "ximalaya", label: "喜马拉雅" },
];

const sourceContentSections: Array<{
  type: ContentType;
  label: string;
  description: string;
  icon: LucideIcon;
}> = [
  { type: "video", label: "视频", description: "投稿、节目与影像更新", icon: Play },
  { type: "article", label: "文章", description: "图文、动态与文字更新", icon: FileText },
  { type: "podcast", label: "播客", description: "单集与音频节目", icon: Headphones },
];

function cloneDefaultData(): AppData {
  return normalizeAppData(JSON.parse(JSON.stringify(defaultAppData))) ?? defaultAppData;
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

function comparePublishedAtDescending(left: ContentItem, right: ContentItem) {
  const leftTime = new Date(left.publishedAt).getTime();
  const rightTime = new Date(right.publishedAt).getTime();
  const leftValid = Number.isFinite(leftTime);
  const rightValid = Number.isFinite(rightTime);
  if (leftValid && rightValid && leftTime !== rightTime) return rightTime - leftTime;
  if (leftValid !== rightValid) return leftValid ? -1 : 1;
  return left.id.localeCompare(right.id);
}

function sourceForItem(data: AppData, item: ContentItem) {
  return data.sources.find((source) => source.id === item.sourceId);
}

function itemIsNew(item: ContentItem) {
  return !item.read && item.isNew !== false;
}

function opensBilibiliVideoExternally(source: Source | undefined, item: ContentItem) {
  return (
    source?.platform === "bilibili" &&
    item.type === "video" &&
    source.bilibiliOpenMode === "external"
  );
}

function safeExternalUrl(value: string) {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    if (typeof window !== "undefined" && url.origin === window.location.origin) return null;
    return url.href;
  } catch {
    return null;
  }
}

function normalizedPublicUrl(value: unknown) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value.trim());
    if (!["http:", "https:"].includes(url.protocol)) return null;
    url.hash = "";
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
    return url.href;
  } catch {
    return null;
  }
}

function comparableSourceUrl(value: string) {
  const normalized = normalizedPublicUrl(value);
  if (!normalized) return "";
  const url = new URL(normalized);
  if (url.hostname === "space.bilibili.com") {
    const mid = url.pathname.match(/^\/(\d+)/)?.[1];
    if (mid) return `https://space.bilibili.com/${mid}`;
  }
  for (const key of [...url.searchParams.keys()]) {
    if (/^(?:utm_|spm|spm_id_from|from|share_)/i.test(key)) url.searchParams.delete(key);
  }
  return url.href;
}

function assistantText(value: unknown, limit: number) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, limit) : "";
}

function normalizeAssistantCandidate(value: unknown): AssistantSourceCandidate | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const url = normalizedPublicUrl(candidate.url);
  if (!url) return null;
  const imageUrl = normalizedPublicUrl(candidate.imageUrl);
  return {
    url,
    name: assistantText(candidate.name, 120) || new URL(url).hostname,
    externalId: assistantText(candidate.externalId, 80) || undefined,
    imageUrl: imageUrl || undefined,
  };
}

function normalizeAssistantQueue(value: unknown): AssistantQueueItem[] {
  if (!Array.isArray(value)) return [];
  const result: AssistantQueueItem[] = [];
  const ids = new Set<string>();
  for (const raw of value.slice(0, 500)) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const id = assistantText(item.id, 160);
    const capturedAt = assistantText(item.capturedAt, 64) || new Date().toISOString();
    if (!id || ids.has(id)) continue;
    if (item.kind === "clip" && item.page && typeof item.page === "object") {
      const page = item.page as Record<string, unknown>;
      const url = normalizedPublicUrl(page.url);
      if (!url) continue;
      const imageUrl = normalizedPublicUrl(page.imageUrl);
      result.push({
        id,
        kind: "clip",
        capturedAt,
        destination: item.destination === "collection" ? "collection" : "later",
        page: {
          url,
          title: assistantText(page.title, 240) || new URL(url).hostname,
          description: assistantText(page.description, 800) || undefined,
          selection: assistantText(page.selection, 2_000) || undefined,
          siteName: assistantText(page.siteName, 120) || undefined,
          imageUrl: imageUrl || undefined,
          contentType: ["video", "podcast"].includes(String(page.contentType))
            ? (page.contentType as ContentType)
            : "article",
        },
      });
      ids.add(id);
      continue;
    }
    if (item.kind === "source") {
      const candidate = normalizeAssistantCandidate(item.candidate);
      if (!candidate) continue;
      result.push({ id, kind: "source", candidate, capturedAt });
      ids.add(id);
      continue;
    }
    if (item.kind === "follow-batch" && item.platform === "bilibili") {
      const candidates = (Array.isArray(item.candidates) ? item.candidates : [])
        .map(normalizeAssistantCandidate)
        .filter((candidate): candidate is AssistantSourceCandidate => Boolean(candidate));
      if (!candidates.length) continue;
      result.push({
        id,
        kind: "follow-batch",
        platform: "bilibili",
        capturedAt,
        candidates: Array.from(new Map(candidates.map((candidate) => [comparableSourceUrl(candidate.url), candidate])).values()),
        added: (Array.isArray(item.added) ? item.added : [])
          .map(normalizeAssistantCandidate)
          .filter((candidate): candidate is AssistantSourceCandidate => Boolean(candidate)),
        removed: (Array.isArray(item.removed) ? item.removed : [])
          .map(normalizeAssistantCandidate)
          .filter((candidate): candidate is AssistantSourceCandidate => Boolean(candidate)),
        previousCount: Number.isFinite(Number(item.previousCount)) ? Math.max(0, Number(item.previousCount)) : 0,
      });
      ids.add(id);
    }
  }
  return result;
}

function normalizeAppData(value: unknown): AppData | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (
    ![1, 2].includes(Number(candidate.version)) ||
    !Array.isArray(candidate.sources) ||
    !Array.isArray(candidate.items) ||
    !Array.isArray(candidate.collections) ||
    !candidate.settings ||
    typeof candidate.settings !== "object"
  ) {
    return null;
  }

  const now = new Date().toISOString();
  const items = (candidate.items as ContentItem[]).map((item) => {
    const discoveredAt = item.discoveredAt ?? item.publishedAt ?? now;
    const publishedTime = new Date(item.publishedAt).getTime();
    const discoveredTime = new Date(discoveredAt).getTime();
    const looksLikeLegacyDiscoveryFallback =
      item.publishedAtReliable === undefined &&
      !item.isDemo &&
      item.id.startsWith("feed-") &&
      item.discoveredAt !== undefined &&
      Number.isFinite(publishedTime) &&
      Number.isFinite(discoveredTime) &&
      Math.abs(publishedTime - discoveredTime) < 5_000;
    const publishedAtReliable = looksLikeLegacyDiscoveryFallback
      ? false
      : item.publishedAtReliable !== false;
    const isNew = item.isNew ?? !item.read;
    return {
      ...item,
      isNew,
      publishedAtReliable,
      publishedLabel: publishedAtReliable
        ? item.publishedLabel
        : `${relativeTimeLabel(discoveredAt)}发现`,
      dateGroup: publishedAtReliable
        ? item.dateGroup
        : isNew
          ? dateGroup(discoveredAt)
          : "更早",
      discoveredAt,
      viewedAt: item.viewedAt ?? (item.read ? item.publishedAt ?? now : undefined),
    };
  });
  const sources = (candidate.sources as Source[]).map<Source>((source) => ({
    ...source,
    imageUrl: normalizedPublicUrl(source.imageUrl) || undefined,
    bilibiliOpenMode:
      source.platform === "bilibili"
        ? source.bilibiliOpenMode === "external"
          ? "external"
          : "embedded"
        : undefined,
    rsshubSelections:
      source.rsshubSelections ??
      (source.rsshubSelection
        ? [{ id: source.rsshubSelection, title: "已保存的内容范围" }]
        : undefined),
    addedAt: source.addedAt ?? now,
    baselineAt: source.baselineAt ?? now,
    knownItemIds:
      source.knownItemIds ??
      items.filter((item) => item.sourceId === source.id).map((item) => item.id),
  }));
  const settings = candidate.settings as AppData["settings"];

  return {
    version: 2,
    sources,
    items,
    collections: candidate.collections as Collection[],
    platformSessions: Array.isArray(candidate.platformSessions)
      ? (candidate.platformSessions as PlatformSession[])
      : [],
    settings: {
      localMatching: Boolean(settings.localMatching),
      includeCollectionUpdates: settings.includeCollectionUpdates !== false,
      hiddenSuggestionIds: Array.isArray(settings.hiddenSuggestionIds)
        ? settings.hiddenSuggestionIds
        : [],
      welcomeDismissed: Boolean(settings.welcomeDismissed),
    },
  };
}

export function OurChoiceApp() {
  const [data, setData] = useState<AppData>(cloneDefaultData);
  const [hydrated, setHydrated] = useState(false);
  const [view, setView] = useState<View>("today");
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [sourceDetailId, setSourceDetailId] = useState<string | null>(null);
  const [sourceSettingsId, setSourceSettingsId] = useState<string | null>(null);
  const [selectedSourceIds, setSelectedSourceIds] = useState<string[]>([]);
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
  const [viewer, setViewer] = useState<ViewerState | null>(null);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [assistantQueue, setAssistantQueue] = useState<AssistantQueueItem[]>([]);
  const [assistantQueueOrigin, setAssistantQueueOrigin] = useState<"extension" | "file">("extension");
  const [assistantPairingCode, setAssistantPairingCode] = useState("");
  const [assistantChecking, setAssistantChecking] = useState(false);
  const [assistantImporting, setAssistantImporting] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const assistantImportRef = useRef<HTMLInputElement>(null);
  const assistantQueueRef = useRef<AssistantQueueItem[]>([]);
  const assistantQueueOriginRef = useRef<"extension" | "file">("extension");
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const assistantCheckTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      try {
        const saved = window.localStorage.getItem(STORAGE_KEY);
        if (saved) {
          const parsed: unknown = JSON.parse(saved);
          const normalized = normalizeAppData(parsed);
          if (normalized) setData(normalized);
        }
        const assistantSaved = window.localStorage.getItem(ASSISTANT_STORAGE_KEY);
        if (assistantSaved) {
          const parsed = JSON.parse(assistantSaved) as { pairingCode?: unknown };
          if (typeof parsed.pairingCode === "string") {
            setAssistantPairingCode(parsed.pairingCode.slice(0, 160));
          }
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
    if (!hydrated) return;
    try {
      if (assistantPairingCode) {
        window.localStorage.setItem(
          ASSISTANT_STORAGE_KEY,
          JSON.stringify({ pairingCode: assistantPairingCode }),
        );
      } else {
        window.localStorage.removeItem(ASSISTANT_STORAGE_KEY);
      }
    } catch {
      // Pairing remains usable for this tab if local storage is unavailable.
    }
  }, [assistantPairingCode, hydrated]);

  useEffect(() => {
    const handoffRequested = hydrated && window.location.hash === ASSISTANT_HANDOFF_HASH;
    let handoffSettled = false;
    const retryTimers: Array<ReturnType<typeof setTimeout>> = [];

    function requestQueue() {
      if (!assistantPairingCode) return;
      window.postMessage(
        {
          source: "our-choice-app",
          type: "OUR_CHOICE_PULL_QUEUE",
          requestId: createId("assistant-request"),
          pairingCode: assistantPairingCode,
        },
        window.location.origin,
      );
    }

    function handleAssistantMessage(event: MessageEvent) {
      if (event.source !== window || event.origin !== window.location.origin) return;
      if (event.data?.source !== "our-choice-extension") return;
      if (event.data.type === "OUR_CHOICE_EXTENSION_READY") {
        requestQueue();
        return;
      }
      if (event.data.type !== "OUR_CHOICE_QUEUE_RESPONSE") return;
      handoffSettled = true;
      if (assistantCheckTimer.current) clearTimeout(assistantCheckTimer.current);
      setAssistantChecking(false);
      const response = event.data.response as { ok?: boolean; items?: unknown; error?: string } | undefined;
      if (!response?.ok) {
        setSettingsOpen(true);
        if (response?.error) showToast({ message: response.error });
        return;
      }
      const items = normalizeAssistantQueue(response.items);
      if (assistantQueueOriginRef.current === "file" && assistantQueueRef.current.length) return;
      assistantQueueRef.current = items;
      assistantQueueOriginRef.current = "extension";
      setAssistantQueue(items);
      setAssistantQueueOrigin("extension");
      if (items.length) setAssistantOpen(true);
      else if (handoffRequested) showToast({ message: "浏览器助手没有待处理内容，请返回扩展重试。" });
    }

    window.addEventListener("message", handleAssistantMessage);
    window.addEventListener("focus", requestQueue);
    const requestWhenVisible = () => {
      if (document.visibilityState === "visible") requestQueue();
    };
    document.addEventListener("visibilitychange", requestWhenVisible);

    if (handoffRequested) {
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
      if (!assistantPairingCode) {
        retryTimers.push(setTimeout(() => {
          setSettingsOpen(true);
          showToast({ message: "请先生成配对码，并在扩展连接设置中保存同一个配对码。" });
        }, 0));
      } else {
        retryTimers.push(setTimeout(() => {
          if (handoffSettled) return;
          setAssistantChecking(true);
          showToast({ message: "正在连接浏览器助手…" });
        }, 0));
        for (const delay of [250, 900]) {
          retryTimers.push(setTimeout(() => {
            if (!handoffSettled) requestQueue();
          }, delay));
        }
        if (assistantCheckTimer.current) clearTimeout(assistantCheckTimer.current);
        assistantCheckTimer.current = setTimeout(() => {
          if (handoffSettled) return;
          setAssistantChecking(false);
          setSettingsOpen(true);
          showToast({ message: "浏览器助手没有响应，请重新加载扩展并确认配对码相同。" });
        }, 1_800);
      }
    }
    if (hydrated) requestQueue();
    return () => {
      window.removeEventListener("message", handleAssistantMessage);
      window.removeEventListener("focus", requestQueue);
      document.removeEventListener("visibilitychange", requestWhenVisible);
      for (const timer of retryTimers) clearTimeout(timer);
      if (handoffRequested && assistantCheckTimer.current) {
        clearTimeout(assistantCheckTimer.current);
        assistantCheckTimer.current = null;
      }
    };
  }, [assistantPairingCode, hydrated]);

  useEffect(() => {
    function handleStorage(event: StorageEvent) {
      if (event.key !== STORAGE_KEY || !event.newValue) return;
      try {
        const parsed: unknown = JSON.parse(event.newValue);
        const normalized = normalizeAppData(parsed);
        if (normalized) setData(normalized);
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
      if (assistantCheckTimer.current) clearTimeout(assistantCheckTimer.current);
    };
  }, []);

  const activeSources = useMemo(
    () => data.sources.filter((source) => !source.archived),
    [data.sources],
  );
  const sourceSettingsSource = activeSources.find(
    (source) => source.id === sourceSettingsId,
  );
  const sourceDetailSource = activeSources.find((source) => source.id === sourceDetailId);

  const inboxItems = useMemo(() => {
    const activeIds = new Set(
      activeSources.filter((source) => source.enabled).map((source) => source.id),
    );
    return data.items.filter((item) => activeIds.has(item.sourceId));
  }, [activeSources, data.items]);

  const unreadCount = inboxItems.filter(itemIsNew).length;
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
    setViewer(null);
    setSourceDetailId(null);
    if (next !== "subscriptions") setSelectedSourceIds([]);
    setView(next);
    setMobileMenuOpen(false);
    setQuery("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function rememberPlatformSession(source: Source, url: string) {
    let origin: string;
    try {
      origin = new URL(url).origin;
    } catch {
      return;
    }
    const openedAt = new Date().toISOString();
    setData((current) => {
      const existing = current.platformSessions.find((session) => session.origin === origin);
      const nextSession: PlatformSession = existing
        ? { ...existing, platform: source.platform, lastOpenedAt: openedAt }
        : {
            origin,
            platform: source.platform,
            firstOpenedAt: openedAt,
            lastOpenedAt: openedAt,
          };
      return {
        ...current,
        platformSessions: [
          nextSession,
          ...current.platformSessions.filter((session) => session.origin !== origin),
        ],
        sources: current.sources.map((candidate) =>
          candidate.id === source.id ? { ...candidate, lastOpenedAt: openedAt } : candidate,
        ),
      };
    });
  }

  function openSource(source: Source) {
    const url = safeExternalUrl(source.url);
    if (!url) {
      showToast({ message: "这个来源没有可安全打开的公开网页" });
      return;
    }
    rememberPlatformSession(source, url);
    setQuery("");
    setViewer({
      kind: "source",
      url,
      title: source.name,
      sourceName: source.name,
      platform: platformLabels[source.platform],
      returnScrollY: window.scrollY,
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function openSourceDetails(source: Source) {
    setViewer(null);
    setQuery("");
    setSourceDetailId(source.id);
    setView("subscriptions");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function openContent(item: ContentItem) {
    const source = sourceForItem(data, item);
    const url = safeExternalUrl(item.url);
    if (!source || !url) {
      showToast({ message: "这条内容没有可安全打开的公开网页" });
      return;
    }
    setItemRead(item.id, true);
    rememberPlatformSession(source, url);
    setQuery("");
    if (opensBilibiliVideoExternally(source, item)) {
      window.open(url, "_blank", "noopener,noreferrer");
      setOpenCollectionId(null);
      setFocusOpen(false);
      return;
    }
    setViewer({
      kind: "content",
      url,
      title: item.title,
      sourceName: source.name,
      platform: platformLabels[source.platform],
      returnScrollY: window.scrollY,
    });
    setOpenCollectionId(null);
    setFocusOpen(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function closeViewer() {
    const returnScrollY = viewer?.returnScrollY ?? 0;
    setViewer(null);
    window.requestAnimationFrame(() => window.scrollTo({ top: returnScrollY, behavior: "smooth" }));
  }

  function setItemRead(itemId: string, read: boolean) {
    setData((current) => {
      const item = current.items.find((candidate) => candidate.id === itemId);
      if (!item || item.read === read) return current;
      const items = current.items.map((candidate) =>
        candidate.id === itemId
          ? {
              ...candidate,
              read,
              viewedAt: read ? new Date().toISOString() : undefined,
            }
          : candidate,
      );
      return {
        ...current,
        items,
        sources: current.sources.map((source) =>
          source.id === item.sourceId
            ? { ...source, unreadCount: items.filter((candidate) => candidate.sourceId === source.id && itemIsNew(candidate)).length }
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
    const changedIds = inboxItems.filter(itemIsNew).map((item) => item.id);
    if (!changedIds.length) {
      showToast({ message: "今天的内容已经全部读完" });
      return;
    }
    const changedSet = new Set(changedIds);
    setData((current) => ({
      ...current,
      items: current.items.map((item) =>
        changedSet.has(item.id)
          ? { ...item, read: true, viewedAt: new Date().toISOString() }
          : item,
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
            changedSet.has(item.id) ? { ...item, read: false, viewedAt: undefined } : item,
          ),
          sources: current.sources.map((source) => ({
            ...source,
            unreadCount: current.items.filter(
              (item) => item.sourceId === source.id && changedSet.has(item.id) && item.isNew !== false,
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
        if (sourceDetailId === source.id) setSourceDetailId(null);
        if (sourceSettingsId === source.id) setSourceSettingsId(null);
        setSelectedSourceIds((current) => current.filter((id) => id !== source.id));
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

  function requestRemoveSelectedSources() {
    const selectedIds = new Set(selectedSourceIds);
    const selectedSources = activeSources.filter((source) => selectedIds.has(source.id));
    if (!selectedSources.length) return;

    const sourceIds = new Set(selectedSources.map((source) => source.id));
    const count = selectedSources.length;
    setConfirmState({
      title: `删除选中的 ${count} 个来源？`,
      description: "之后不再获取这些来源的新内容；已经加入稍后看或合集的内容会保留。",
      confirmLabel: `删除 ${count} 个来源`,
      danger: true,
      onConfirm: () => {
        if (sourceDetailId && sourceIds.has(sourceDetailId)) setSourceDetailId(null);
        if (sourceSettingsId && sourceIds.has(sourceSettingsId)) setSourceSettingsId(null);
        setSelectedSourceIds([]);
        setData((current) => ({
          ...current,
          sources: current.sources.map((source) =>
            sourceIds.has(source.id)
              ? { ...source, archived: true, enabled: false, unreadCount: 0 }
              : source,
          ),
          items: current.items.filter(
            (item) => !sourceIds.has(item.sourceId) || item.collectionIds.length > 0,
          ),
        }));
        setConfirmState(null);
        showToast({ message: `已删除 ${count} 个来源` });
      },
    });
  }

  function normalizePreviewItems(
    source: Source,
    items: PreviewItem[],
    options: { isNew: boolean; discoveredAt?: string } = { isNew: true },
  ) {
    const discoveredAt = options.discoveredAt ?? new Date().toISOString();
    return items.map<ContentItem>((item, index) => {
      const publishedAtReliable = item.publishedAtReliable !== false;
      return {
        id: `feed-${source.id}-${stableKey(item.upstreamId || item.url || String(index))}`,
        sourceId: source.id,
        title: item.title,
        summary: item.summary || "打开原站查看这条更新。",
        type: item.type,
        url: item.url,
        publishedAt: item.publishedAt,
        publishedAtReliable,
        publishedLabel: publishedAtReliable
          ? relativeTimeLabel(item.publishedAt)
          : `${relativeTimeLabel(discoveredAt)}发现`,
        dateGroup: publishedAtReliable
          ? dateGroup(item.publishedAt)
          : options.isNew
            ? dateGroup(discoveredAt)
            : "更早",
        duration: item.duration,
        read: false,
        isNew: options.isNew,
        discoveredAt,
        thumbnailUrl: item.thumbnailUrl,
        tone: source.tone,
        visualLabel:
          item.type === "video" ? "WATCH / NEW" : item.type === "podcast" ? "LISTEN / NEW" : "READ / NEW",
        collectionIds: [],
      };
    });
  }

  async function fetchPreview(
    url: string,
    limit = 12,
    selections?: string[],
    manual?: RssHubManualSubscription,
  ) {
    const response = await fetch("/api/source-preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: url || undefined, limit, selections, manual }),
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
        Boolean(source.feedUrl || source.refreshUrl || source.manualSubscription) &&
        (!sourceIds || sourceIds.includes(source.id)),
    );

    if (!online) {
      showToast({ message: "当前处于离线状态，仍可查看已保存的内容" });
      return;
    }
    if (!candidates.length) {
      showToast({ message: "暂无可自动刷新的 RSS 来源；链接订阅仍可直接前往查看" });
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
            const preview = await fetchPreview(
              source.refreshUrl ?? source.feedUrl ?? source.url,
              12,
              source.rsshubSelections?.map((selection) => selection.id) ??
                (source.rsshubSelection ? [source.rsshubSelection] : undefined),
              source.manualSubscription,
            );
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
        return { ...result, additions: [] as ContentItem[], observedIds: [] as string[] };
      }
      const discoveredAt = result.preview.fetchedAt ?? new Date().toISOString();
      const normalized = normalizePreviewItems(result.source, result.preview.items, {
        isNew: false,
        discoveredAt,
      });
      const firstIdentityVerification =
        result.source.platform === "bilibili" &&
        result.preview.source.identityVerified === true &&
        result.source.identityVerified !== true;
      const knownIds = new Set(
        firstIdentityVerification ? [] : (result.source.knownItemIds ?? []),
      );
      const existingSourceUrls = new Set(
        data.items
          .filter((item) => item.sourceId === result.source.id)
          .map((item) => item.url),
      );
      const preservedSourceUrls = new Set(
        data.items
          .filter(
            (item) => item.sourceId === result.source.id && item.collectionIds.length > 0,
          )
          .map((item) => item.url),
      );
      const addedAt = new Date(result.source.addedAt ?? result.source.baselineAt ?? 0).getTime();
      const additions = normalized
        .filter(
          (item) =>
            !knownIds.has(item.id) &&
            (!existingUrls.has(item.url) ||
              (firstIdentityVerification &&
                existingSourceUrls.has(item.url) &&
                !preservedSourceUrls.has(item.url))),
        )
        .map((item) => {
          const normalizedIndex = normalized.findIndex((candidate) => candidate.id === item.id);
          const previewItem = result.preview?.items[normalizedIndex];
          const publishedAt = new Date(item.publishedAt).getTime();
          const hasReliableDate = previewItem?.publishedAtReliable !== false;
          return {
            ...item,
            isNew:
              hasReliableDate && Number.isFinite(publishedAt)
                ? publishedAt > addedAt
                : Boolean(result.source.baselineAt),
            dateGroup:
              !hasReliableDate && result.source.baselineAt
                ? dateGroup(item.discoveredAt ?? discoveredAt)
                : item.dateGroup,
          };
        });
      for (const item of additions) existingUrls.add(item.url);
      return {
        ...result,
        additions,
        observedIds: normalized.map((item) => item.id),
        firstIdentityVerification,
      };
    });
    const totalNew = prepared.reduce(
      (total, result) => total + result.additions.filter(itemIsNew).length,
      0,
    );
    const mismatchedSourceIds = new Set(
      results
        .filter((result) => result.preview?.warning?.code === "RSSHUB_SOURCE_MISMATCH")
        .map((result) => result.source.id),
    );
    const reverifiedSourceIds = new Set(
      prepared
        .filter((result) => result.firstIdentityVerification)
        .map((result) => result.source.id),
    );

    setData((current) => {
      let items = current.items.filter(
        (item) =>
          (!mismatchedSourceIds.has(item.sourceId) &&
            !reverifiedSourceIds.has(item.sourceId)) ||
          item.collectionIds.length > 0,
      );
      const sourceUpdates = new Map<string, { partial: boolean }>();

      for (const result of prepared) {
        if (!result.preview || result.preview.mode !== "live") continue;
        sourceUpdates.set(result.source.id, {
          partial: result.preview.warning?.code === "RSSHUB_PARTIAL",
        });
        items = [...result.additions, ...items];
      }

      return {
        ...current,
        items,
        sources: current.sources.map((source) => {
          if (mismatchedSourceIds.has(source.id)) {
            return {
              ...source,
              lastSyncLabel: "来源异常",
              unreadCount: items.filter(
                (item) => item.sourceId === source.id && itemIsNew(item),
              ).length,
              knownItemIds: [],
            };
          }
          return sourceUpdates.has(source.id)
            ? {
                ...source,
                lastSyncLabel: sourceUpdates.get(source.id)?.partial ? "部分更新" : "刚刚",
                identityVerified:
                  prepared.find((result) => result.source.id === source.id)?.preview?.source
                    .identityVerified === true || source.identityVerified,
                unreadCount: items.filter(
                  (item) => item.sourceId === source.id && itemIsNew(item),
                ).length,
                knownItemIds: Array.from(
                  new Set([
                    ...(prepared.find((result) => result.source.id === source.id)?.observedIds ?? []),
                    ...(source.knownItemIds ?? []),
                  ]),
                ).slice(0, 500),
              }
            : source;
        }),
      };
    });

    const failed = results.filter((result) => result.error).length;
    const mismatched = mismatchedSourceIds.size;
    const partial = results.filter(
      (result) => result.preview?.warning?.code === "RSSHUB_PARTIAL",
    ).length;
    setSyncing(false);
    if (mismatched) {
      showToast({
        message: `${mismatched} 个 B站来源未通过 UP 主身份校验；已移除未收藏的可疑内容`,
        actionLabel: "重试",
        onAction: () => void refreshSources(sourceIds),
      });
    } else if (failed) {
      showToast({
        message: `${failed} 个来源更新失败，已保留上次成功获取的内容`,
        actionLabel: "重试",
        onAction: () => void refreshSources(sourceIds),
      });
    } else if (partial) {
      showToast({
        message: `${partial} 个来源只完成部分更新；已保留成功获取的内容`,
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
      const normalized = normalizeAppData(parsed);
      if (!normalized) throw new Error("invalid");
      setData(normalized);
      setSettingsOpen(false);
      showToast({ message: "备份已导入，本地内容恢复完成" });
    } catch {
      showToast({ message: "没有认出这个备份文件，请确认格式后重试" });
    }
  }

  function generateAssistantPairingCode() {
    const bytes = new Uint8Array(18);
    crypto.getRandomValues(bytes);
    const code = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    setAssistantPairingCode(code);
    showToast({ message: "新的浏览器助手配对码已生成" });
  }

  async function copyAssistantPairingCode() {
    if (!assistantPairingCode) return;
    try {
      await navigator.clipboard.writeText(assistantPairingCode);
      showToast({ message: "配对码已复制，请粘贴到扩展连接设置" });
    } catch {
      showToast({ message: "无法自动复制，请手动选择配对码" });
    }
  }

  function revokeAssistantPairing() {
    setAssistantPairingCode("");
    assistantQueueRef.current = [];
    assistantQueueOriginRef.current = "extension";
    setAssistantQueue([]);
    setAssistantOpen(false);
    showToast({ message: "浏览器助手配对已撤销" });
  }

  function checkAssistantQueue() {
    if (!assistantPairingCode) {
      setSettingsOpen(true);
      showToast({ message: "请先在设置中生成浏览器助手配对码" });
      return;
    }
    setAssistantChecking(true);
    window.postMessage(
      {
        source: "our-choice-app",
        type: "OUR_CHOICE_PULL_QUEUE",
        requestId: createId("assistant-request"),
        pairingCode: assistantPairingCode,
      },
      window.location.origin,
    );
    if (assistantCheckTimer.current) clearTimeout(assistantCheckTimer.current);
    assistantCheckTimer.current = setTimeout(() => {
      setAssistantChecking(false);
      showToast({ message: "没有收到扩展响应，请确认已安装、启用并填写相同配对码" });
    }, 1_800);
  }

  function acknowledgeAssistantQueue(ids: string[]) {
    if (!ids.length || !assistantPairingCode) return;
    window.postMessage(
      {
        source: "our-choice-app",
        type: "OUR_CHOICE_ACK_QUEUE",
        requestId: createId("assistant-ack"),
        pairingCode: assistantPairingCode,
        ids,
      },
      window.location.origin,
    );
  }

  async function importAssistantJson(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text()) as { version?: unknown; items?: unknown };
      const items = normalizeAssistantQueue(parsed.items);
      if (Number(parsed.version) !== 1 || !items.length) throw new Error("invalid");
      assistantQueueRef.current = items;
      assistantQueueOriginRef.current = "file";
      setAssistantQueue(items);
      setAssistantQueueOrigin("file");
      setSettingsOpen(false);
      setAssistantOpen(true);
    } catch {
      showToast({ message: "没有认出这个浏览器助手导出文件" });
    }
  }

  async function processAssistantImport(selection: AssistantImportSelection) {
    if (assistantImporting) return;
    setAssistantImporting(true);
    const selectedClipIds = new Set(selection.clipIds);
    const selectedSourceKeys = new Set(selection.sourceKeys);
    const allQueueIds = assistantQueue.map((item) => item.id);
    const failedQueueIds = new Set<string>();

    const sourceRequests: Array<{
      queueId: string;
      key: string;
      candidate: AssistantSourceCandidate;
      batchId?: string;
    }> = [];
    for (const item of assistantQueue) {
      if (item.kind === "source") {
        const key = `${item.id}:${comparableSourceUrl(item.candidate.url)}`;
        if (selectedSourceKeys.has(key)) {
          sourceRequests.push({ queueId: item.id, key, candidate: item.candidate });
        }
      }
      if (item.kind === "follow-batch") {
        for (const candidate of item.candidates) {
          const key = `${item.id}:${comparableSourceUrl(candidate.url)}`;
          if (selectedSourceKeys.has(key)) {
            sourceRequests.push({ queueId: item.id, key, candidate, batchId: item.id });
          }
        }
      }
    }

    const existingSourceUrls = new Set(
      data.sources.filter((source) => !source.archived).map((source) => comparableSourceUrl(source.url)),
    );
    const uniqueRequests = Array.from(
      new Map(
        sourceRequests
          .filter((request) => !existingSourceUrls.has(comparableSourceUrl(request.candidate.url)))
          .map((request) => [comparableSourceUrl(request.candidate.url), request]),
      ).values(),
    );
    const preparedSources: Source[] = [];
    let requestIndex = 0;
    const workerCount = Math.min(3, uniqueRequests.length);

    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        while (requestIndex < uniqueRequests.length) {
          const request = uniqueRequests[requestIndex];
          requestIndex += 1;
          try {
            let preview = await fetchPreview(request.candidate.url, 3);
            if (preview.mode === "select") {
              const preferred =
                preview.options?.find((option) => /投稿|视频/.test(option.title)) ??
                preview.options?.[0];
              if (!preferred) throw new Error("没有可用的订阅范围");
              preview = await fetchPreview(request.candidate.url, 3, [preferred.id]);
            }
            if (preview.mode === "select") throw new Error("仍需选择订阅范围");
            const baselineAt = preview.fetchedAt ?? new Date().toISOString();
            const sourceId = createId("source");
            const name = request.candidate.name || preview.source.title;
            const source: Source = {
              id: sourceId,
              name,
              description:
                preview.source.description ||
                (preview.mode === "live" ? "通过浏览器助手导入的可同步来源" : "通过浏览器助手导入的平台链接"),
              imageUrl: request.candidate.imageUrl ?? preview.source.imageUrl,
              platform: preview.source.kind,
              url:
                preview.source.siteUrl ||
                preview.source.profileUrl ||
                preview.source.refreshUrl ||
                preview.source.feedUrl ||
                request.candidate.url,
              feedUrl: preview.source.feedUrl,
              refreshUrl: preview.source.refreshUrl,
              provider: preview.source.provider,
              rsshubSelection: preview.source.rsshubSelection,
              rsshubSelections: preview.source.rsshubSelections,
              manualSubscription: preview.source.manualSubscription,
              identityVerified: preview.source.identityVerified,
              bilibiliOpenMode: preview.source.kind === "bilibili" ? "embedded" : undefined,
              initials: name.slice(0, 1),
              tone: TONES[(data.sources.length + preparedSources.length) % TONES.length],
              enabled: true,
              lastSyncLabel: preview.mode === "live" ? "刚刚" : "链接模式",
              unreadCount: 0,
              addedAt: baselineAt,
              baselineAt,
              importedFrom: "browser-extension",
              externalId: request.candidate.externalId,
              importBatchId: request.batchId,
            };
            source.knownItemIds =
              preview.mode === "live"
                ? normalizePreviewItems(source, preview.items, {
                    isNew: false,
                    discoveredAt: baselineAt,
                  }).map((item) => item.id)
                : [];
            preparedSources.push(source);
          } catch {
            failedQueueIds.add(request.queueId);
          }
        }
      }),
    );

    const selectedClips = assistantQueue.filter(
      (item): item is Extract<AssistantQueueItem, { kind: "clip" }> =>
        item.kind === "clip" && selectedClipIds.has(item.id),
    );
    const ownedCollectionIds = new Set(
      data.collections.filter((collection) => collection.owned).map((collection) => collection.id),
    );
    for (const queued of selectedClips) {
      if (!ownedCollectionIds.has(selection.destinations[queued.id])) {
        failedQueueIds.add(queued.id);
      }
    }

    let duplicateCount = sourceRequests.length - uniqueRequests.length;
    const seenClipUrls = new Set(data.items.map((item) => comparableSourceUrl(item.url)));
    let savedClips = 0;
    for (const queued of selectedClips) {
      if (failedQueueIds.has(queued.id)) continue;
      const key = comparableSourceUrl(queued.page.url);
      if (seenClipUrls.has(key)) duplicateCount += 1;
      else {
        seenClipUrls.add(key);
        savedClips += 1;
      }
    }
    const preparedSourceUrls = new Set(existingSourceUrls);
    const sourcesToSave = preparedSources.filter((source) => {
      const key = comparableSourceUrl(source.url);
      if (preparedSourceUrls.has(key)) {
        duplicateCount += 1;
        return false;
      }
      preparedSourceUrls.add(key);
      return true;
    });
    const savedSources = sourcesToSave.length;

    setData((current) => {
      const sources = [...current.sources];
      const items = [...current.items];
      const collections = current.collections.map((collection) => ({
        ...collection,
        itemIds: [...collection.itemIds],
      }));

      let clipSource = sources.find((source) => source.id === CLIP_SOURCE_ID);
      if (savedClips > 0 && !clipSource) {
        clipSource = {
          id: CLIP_SOURCE_ID,
          name: "网页剪藏",
          description: "通过自选浏览器助手主动保存的网页",
          platform: "web",
          url: "#",
          initials: "藏",
          tone: "ink",
          enabled: false,
          archived: true,
          isSystem: true,
          lastSyncLabel: "本地收藏",
          unreadCount: 0,
          importedFrom: "browser-extension",
        };
        sources.push(clipSource);
      }

      for (const queued of selectedClips) {
        if (failedQueueIds.has(queued.id)) continue;
        const destinationId = selection.destinations[queued.id];
        const target = collections.find((collection) => collection.id === destinationId && collection.owned);
        if (!target) continue;
        const comparable = comparableSourceUrl(queued.page.url);
        let itemIndex = items.findIndex((candidate) => comparableSourceUrl(candidate.url) === comparable);
        let item = itemIndex >= 0 ? items[itemIndex] : undefined;
        if (!item) {
          if (!clipSource) continue;
          const capturedAt = Number.isFinite(new Date(queued.capturedAt).getTime())
            ? queued.capturedAt
            : new Date().toISOString();
          item = {
            id: `clip-${stableKey(comparable)}`,
            sourceId: CLIP_SOURCE_ID,
            title: queued.page.title,
            summary: queued.page.selection || queued.page.description || "通过浏览器助手保存的网页。",
            type: queued.page.contentType,
            url: queued.page.url,
            publishedAt: capturedAt,
            publishedLabel: "刚刚收藏",
            dateGroup: dateGroup(capturedAt),
            duration: queued.page.selection ? "选中文字" : "网页收藏",
            read: false,
            isNew: false,
            discoveredAt: capturedAt,
            capturedAt,
            selectionText: queued.page.selection,
            capturedFrom: "browser-extension",
            thumbnailUrl: queued.page.imageUrl,
            tone: "ink",
            visualLabel: queued.page.contentType === "video" ? "WATCH / SAVED" : queued.page.contentType === "podcast" ? "LISTEN / SAVED" : "READ / SAVED",
            collectionIds: [],
          };
          items.unshift(item);
          itemIndex = 0;
        }
        if (!item.collectionIds.includes(target.id)) {
          item = { ...item, collectionIds: [...item.collectionIds, target.id] };
          items[itemIndex] = item;
        }
        if (!target.itemIds.includes(item.id)) target.itemIds.unshift(item.id);
        target.updatedLabel = "刚刚";
      }

      const currentUrls = new Set(
        sources.filter((source) => !source.archived).map((source) => comparableSourceUrl(source.url)),
      );
      for (const source of sourcesToSave) {
        const key = comparableSourceUrl(source.url);
        if (currentUrls.has(key)) continue;
        currentUrls.add(key);
        sources.push(source);
      }

      return { ...current, sources, items, collections };
    });

    const acknowledgedIds = allQueueIds.filter((id) => !failedQueueIds.has(id));
    if (assistantQueueOrigin === "extension") acknowledgeAssistantQueue(acknowledgedIds);
    setAssistantQueue((current) => {
      const next = current.filter((item) => !acknowledgedIds.includes(item.id));
      assistantQueueRef.current = next;
      if (!next.length) assistantQueueOriginRef.current = "extension";
      return next;
    });
    if (acknowledgedIds.length === allQueueIds.length) setAssistantQueueOrigin("extension");
    setAssistantImporting(false);
    if (!failedQueueIds.size) setAssistantOpen(false);
    if (savedSources) setView("subscriptions");
    showToast({
      message: `已收藏 ${savedClips} 条、订阅 ${savedSources} 个；跳过 ${duplicateCount} 个重复项${failedQueueIds.size ? `，${failedQueueIds.size} 组待重试` : ""}`,
    });
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
  const nextFocusItem = inboxItems.find(itemIsNew);

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

        <a className="settings-link docs-link" href="/docs/">
          <FileText size={18} />
          <span>文档</span>
        </a>
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
              <strong>
                {viewer
                  ? "站内查看"
                  : query
                    ? "搜索"
                    : sourceDetailSource
                      ? "来源详情"
                      : currentNav.label}
              </strong>
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

          <button
            className="primary-button topbar-add"
            type="button"
            aria-label="添加订阅"
            onClick={() => setAddOpen(true)}
          >
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
          {viewer ? (
            <EmbeddedViewer viewer={viewer} onBack={closeViewer} />
          ) : query ? (
            <SearchResults
              query={query}
              items={searchedItems}
              data={data}
              onMarkRead={markReadWithUndo}
              onOpen={openContent}
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
              onOpen={openContent}
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
            sourceDetailSource ? (
              <SourceDetailView
                source={sourceDetailSource}
                items={data.items.filter((item) => item.sourceId === sourceDetailSource.id)}
                syncing={syncing}
                laterCollectionId={laterCollection?.id}
                onBack={() => {
                  setSourceDetailId(null);
                  window.scrollTo({ top: 0, behavior: "smooth" });
                }}
                onOpenSource={openSource}
                onRefreshSource={(id) => void refreshSources([id])}
                onSettings={(source) => setSourceSettingsId(source.id)}
                onMarkRead={markReadWithUndo}
                onOpen={openContent}
                onToggleLater={toggleLater}
                onSave={openSaveDialog}
              />
            ) : (
              <SubscriptionsView
                sources={activeSources}
                selectedSourceIds={selectedSourceIds}
                totalUnread={unreadCount}
                syncing={syncing}
                onAdd={() => setAddOpen(true)}
                onAssistant={checkAssistantQueue}
                onRefresh={() => void refreshSources()}
                onRefreshSource={(id) => void refreshSources([id])}
                onToggleSource={toggleSource}
                onSelectionChange={setSelectedSourceIds}
                onRemoveSelected={requestRemoveSelectedSources}
                onRemoveSource={requestRemoveSource}
                onOpenDetails={openSourceDetails}
                onOpenSource={openSource}
                onSettings={(source) => setSourceSettingsId(source.id)}
              />
            )
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
        <a href="/docs/">
          <FileText size={20} />
          <span>文档</span>
        </a>
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
            const baselineAt = preview.fetchedAt ?? new Date().toISOString();
            const source: Source = {
              id: sourceId,
              name: name.trim() || preview.source.title,
              description:
                preview.source.description ||
                (preview.mode === "live" ? "通过 RSS 获取的新内容" : "平台链接订阅"),
              imageUrl: preview.source.imageUrl,
              platform: preview.source.kind,
              url:
                preview.source.siteUrl ||
                preview.source.profileUrl ||
                preview.source.refreshUrl ||
                preview.source.feedUrl ||
                "#",
              feedUrl: preview.source.feedUrl,
              refreshUrl: preview.source.refreshUrl,
              provider: preview.source.provider,
              rsshubSelection: preview.source.rsshubSelection,
              rsshubSelections: preview.source.rsshubSelections,
              identityVerified: preview.source.identityVerified,
              bilibiliOpenMode:
                preview.source.kind === "bilibili" ? "embedded" : undefined,
              manualSubscription: preview.source.manualSubscription,
              initials: (name.trim() || preview.source.title).slice(0, 1),
              tone,
              enabled: true,
              lastSyncLabel: preview.mode === "live" ? "刚刚" : "链接模式",
              unreadCount: 0,
              addedAt: baselineAt,
              baselineAt,
            };
            const baselineItems =
              preview.mode === "live"
                ? normalizePreviewItems(source, preview.items, {
                    isNew: false,
                    discoveredAt: baselineAt,
                  })
                : [];
            source.knownItemIds = baselineItems.map((item) => item.id);
            const items =
              preview.mode === "live" && includeRecent
                ? baselineItems.slice(0, 3)
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
                  ? `已订阅「${source.name}」，保留 ${items.length} 条历史内容（不计入新增）`
                  : `已保存「${source.name}」，可在站内打开`,
            });
          }}
        />
      )}

      {sourceSettingsSource && (
        <SourceSettingsModal
          source={sourceSettingsSource}
          onClose={() => setSourceSettingsId(null)}
          onFetchPreview={fetchPreview}
          onSave={(changes, preview) => {
            setData((current) => {
              const savedAt = preview?.fetchedAt ?? new Date().toISOString();
              return {
                ...current,
                sources: current.sources.map((source) => {
                  if (source.id !== sourceSettingsSource.id) return source;
                  const updated: Source = {
                    ...source,
                    name: changes.name,
                    description: changes.description,
                    bilibiliOpenMode: changes.bilibiliOpenMode,
                    initials: changes.name.slice(0, 1) || source.initials,
                    rsshubSelection:
                      changes.rsshubSelections.length === 1
                        ? changes.rsshubSelections[0]!.id
                        : undefined,
                    rsshubSelections:
                      changes.rsshubSelections.length > 0
                        ? changes.rsshubSelections
                        : undefined,
                    lastSyncLabel: preview?.mode === "live" ? "刚刚" : source.lastSyncLabel,
                  };
                  if (preview?.mode === "live") {
                    const observed = normalizePreviewItems(updated, preview.items, {
                      isNew: false,
                      discoveredAt: savedAt,
                    }).map((item) => item.id);
                    updated.knownItemIds = Array.from(
                      new Set([...observed, ...(source.knownItemIds ?? [])]),
                    ).slice(0, 500);
                  }
                  return updated;
                }),
              };
            });
            setSourceSettingsId(null);
            showToast({ message: `已更新「${changes.name}」的来源设置` });
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
          onOpenItem={openContent}
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
          assistantPairingCode={assistantPairingCode}
          assistantChecking={assistantChecking}
          onClose={() => setSettingsOpen(false)}
          onExport={exportData}
          onImport={() => importRef.current?.click()}
          onGenerateAssistantCode={generateAssistantPairingCode}
          onCopyAssistantCode={() => void copyAssistantPairingCode()}
          onRevokeAssistantCode={revokeAssistantPairing}
          onCheckAssistant={checkAssistantQueue}
          onImportAssistant={() => assistantImportRef.current?.click()}
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
          remaining={inboxItems.filter(itemIsNew).length}
          onClose={() => setFocusOpen(false)}
          onMarkRead={setItemRead}
          onOpenItem={openContent}
          onDiscover={() => {
            setFocusOpen(false);
            goTo("discover");
          }}
        />
      )}

      {assistantOpen && (
        <BrowserAssistantModal
          queue={assistantQueue}
          data={data}
          importing={assistantImporting}
          onClose={() => setAssistantOpen(false)}
          onConfirm={(selection) => void processAssistantImport(selection)}
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
      <input
        ref={assistantImportRef}
        className="sr-only"
        type="file"
        accept="application/json,.json"
        onChange={(event) => void importAssistantJson(event)}
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

function EmbeddedViewer({ viewer, onBack }: { viewer: ViewerState; onBack: () => void }) {
  const [reloadKey, setReloadKey] = useState(0);
  const isBilibili = viewer.platform === platformLabels.bilibili;
  const isPlatformSource = ![platformLabels.rss, platformLabels.podcast, platformLabels.web].includes(
    viewer.platform,
  );

  return (
    <section className="embedded-viewer" aria-labelledby="embedded-viewer-title">
      <header className="viewer-header">
        <button className="viewer-back" type="button" onClick={onBack}>
          <ArrowLeft size={18} /> 返回自选
        </button>
        <div className="viewer-heading">
          <div className="viewer-breadcrumb" aria-label="当前位置">
            <span>自选</span>
            <ChevronRight size={13} />
            <span>{viewer.sourceName}</span>
            {viewer.kind === "content" && (
              <>
                <ChevronRight size={13} />
                <span>具体内容</span>
              </>
            )}
          </div>
          <h1 id="embedded-viewer-title">{viewer.title}</h1>
          <p className={isPlatformSource ? "viewer-session-message" : undefined}>
            <ShieldCheck size={14} />
            {isPlatformSource
              ? `${viewer.platform} 的内嵌登录受第三方 Cookie 限制；若仍显示未登录，请使用右侧的当前页登录入口。`
              : `${viewer.platform} 页面在主显示区内加载；内嵌登录取决于浏览器和来源平台的 Cookie 策略。`}
          </p>
        </div>
        <div className="viewer-actions">
          <button className="quiet-button" type="button" onClick={() => setReloadKey((key) => key + 1)}>
            <RefreshCw size={16} /> 重新加载
          </button>
          <a
            className={isPlatformSource ? "secondary-button viewer-login-fallback" : "quiet-button"}
            href={viewer.url}
          >
            {isBilibili
              ? "在当前页打开并登录 B站"
              : isPlatformSource
                ? `在当前页打开并登录${viewer.platform}`
                : "无法嵌入时在当前页打开"}
            <ExternalLink size={15} />
          </a>
        </div>
      </header>

      <div className="viewer-frame-shell">
        <div className="viewer-frame-status">
          <span className="status-dot" /> 正在安全地连接 {viewer.platform}
        </div>
        <iframe
          key={`${viewer.url}-${reloadKey}`}
          src={viewer.url}
          title={`${viewer.title} — ${viewer.platform}`}
          allow="autoplay; encrypted-media; fullscreen; picture-in-picture; clipboard-read; clipboard-write; storage-access"
          sandbox="allow-downloads allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts allow-storage-access-by-user-activation"
          referrerPolicy="strict-origin-when-cross-origin"
        >
          你的浏览器不支持内嵌网页。
        </iframe>
      </div>

      <p className="viewer-disclosure">
        某些平台会通过安全策略拒绝被任何网站内嵌。遇到空白或拦截提示时，可使用上方“在当前页打开”，浏览器返回后阅读记录仍会保留。
      </p>
    </section>
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
  onOpen,
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
  onOpen: (item: ContentItem) => void;
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
      (typeFilter === "all" || item.type === typeFilter) && (!unreadOnly || itemIsNew(item)),
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
            <span className="status-dot" /> 只看新增
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
                    onOpen={() => onOpen(item)}
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
          description="换一个类型，或者关闭“只看新增”试试。"
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
  onOpen,
  onToggleLater,
  onSave,
  laterCollectionId,
}: {
  query: string;
  items: ContentItem[];
  data: AppData;
  onMarkRead: (id: string) => void;
  onOpen: (item: ContentItem) => void;
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
              onOpen={() => onOpen(item)}
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
  onOpen,
  onToggleLater,
  onSave,
}: {
  item: ContentItem;
  source?: Source;
  savedForLater: boolean;
  onMarkRead: () => void;
  onOpen: () => void;
  onToggleLater: () => void;
  onSave: () => void;
}) {
  const [imageFailed, setImageFailed] = useState(false);
  const TypeIcon = item.type === "video" ? Play : item.type === "podcast" ? Headphones : FileText;
  const opensExternally = opensBilibiliVideoExternally(source, item);
  const openLabel = opensExternally ? "打开 Bilibili" : "站内查看";
  const OpenIcon = opensExternally ? ExternalLink : PanelTopOpen;

  return (
    <article className={`content-card ${item.read ? "is-read" : ""}`}>
      <button
        type="button"
        className={`content-visual tone-${item.tone}`}
        onClick={onOpen}
        aria-label={`${item.title}，${openLabel}`}
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
      </button>

      <div className="card-body">
        <div className="source-line">
          <SourceAvatar source={source} size="small" />
          <span>{source?.name ?? "已保存来源"}</span>
          <span className="source-separator">·</span>
          <time
            dateTime={item.publishedAtReliable === false ? item.discoveredAt : item.publishedAt}
            title={item.publishedAtReliable === false ? "原始来源未提供发布时间；这里显示发现时间" : undefined}
          >
            {item.publishedLabel}
          </time>
          {itemIsNew(item) ? (
            <span className="unread-label">新增</span>
          ) : !item.read ? (
            <span className="history-label">订阅前历史</span>
          ) : null}
        </div>
        <button
          type="button"
          className="card-title"
          onClick={onOpen}
        >
          {item.title}
        </button>
        <p className="card-summary">{item.summary}</p>
        <div className="card-actions">
          <button
            type="button"
            className="open-link"
            onClick={onOpen}
          >
            {openLabel} <OpenIcon size={14} />
          </button>
          <div>
            {!item.read && (
              <button type="button" aria-label="标为读过" onClick={onMarkRead}>
                <Check size={17} />
              </button>
            )}
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

function SourceDetailView({
  source,
  items,
  syncing,
  laterCollectionId,
  onBack,
  onOpenSource,
  onRefreshSource,
  onSettings,
  onMarkRead,
  onOpen,
  onToggleLater,
  onSave,
}: {
  source: Source;
  items: ContentItem[];
  syncing: boolean;
  laterCollectionId?: string;
  onBack: () => void;
  onOpenSource: (source: Source) => void;
  onRefreshSource: (id: string) => void;
  onSettings: (source: Source) => void;
  onMarkRead: (id: string) => void;
  onOpen: (item: ContentItem) => void;
  onToggleLater: (id: string) => void;
  onSave: (id: string) => void;
}) {
  const sections = sourceContentSections
    .map((section) => ({
      ...section,
      items: items
        .filter((item) => item.type === section.type)
        .slice()
        .sort(comparePublishedAtDescending),
    }))
    .filter((section) => section.items.length > 0);
  const newCount = items.filter(itemIsNew).length;
  const canRefresh = Boolean(source.feedUrl || source.refreshUrl || source.manualSubscription);

  return (
    <>
      <button className="source-detail-back" type="button" onClick={onBack}>
        <ArrowLeft size={16} /> 返回订阅
      </button>

      <section className="page-heading compact-heading source-detail-heading">
        <div className="source-detail-identity">
          <SourceAvatar source={source} />
          <div>
            <p className="eyebrow">
              {platformLabels[source.platform]} · {source.enabled ? "正在订阅" : "已暂停"}
            </p>
            <h1>{source.name}</h1>
            <p>{source.description}</p>
            <div className="source-detail-meta" aria-label="来源内容概览">
              <span>{items.length} 条内容</span>
              <span>{sections.length} 个分类</span>
              {newCount > 0 && <strong>{newCount} 条新增</strong>}
              {source.platform === "bilibili" && (
                <span>
                  视频：{source.bilibiliOpenMode === "external" ? "新窗口打开" : "站内查看"}
                </span>
              )}
            </div>
          </div>
        </div>
        <div className="heading-actions source-detail-actions">
          <button className="quiet-button" type="button" onClick={() => onOpenSource(source)}>
            <PanelTopOpen size={16} /> 来源主页
          </button>
          <button className="quiet-button" type="button" onClick={() => onSettings(source)}>
            <Settings size={16} /> 设置
          </button>
          {canRefresh && (
            <button
              className="secondary-button"
              type="button"
              disabled={syncing}
              onClick={() => onRefreshSource(source.id)}
            >
              <RefreshCw className={syncing ? "is-spinning" : ""} size={16} />
              {syncing ? "正在更新" : "更新来源"}
            </button>
          )}
        </div>
      </section>

      {sections.length ? (
        sections.map((section) => {
          const SectionIcon = section.icon;
          const headingId = `source-${source.id}-${section.type}`;
          return (
            <section className="content-section source-detail-section" key={section.type} aria-labelledby={headingId}>
              <div className="section-heading source-detail-section-heading">
                <div>
                  <span><SectionIcon size={16} /></span>
                  <div>
                    <h2 id={headingId}>{section.label}</h2>
                    <p>{section.description}</p>
                  </div>
                </div>
                <span>{section.items.length} 条 · 从新到旧</span>
              </div>
              <div className="content-grid">
                {section.items.map((item) => (
                  <ContentCard
                    key={item.id}
                    item={item}
                    source={source}
                    savedForLater={Boolean(
                      laterCollectionId && item.collectionIds.includes(laterCollectionId)
                    )}
                    onMarkRead={() => onMarkRead(item.id)}
                    onOpen={() => onOpen(item)}
                    onToggleLater={() => onToggleLater(item.id)}
                    onSave={() => onSave(item.id)}
                  />
                ))}
              </div>
            </section>
          );
        })
      ) : (
        <EmptyState
          icon={Inbox}
          title="这个来源还没有内容"
          description="可以先更新一次来源；获取到的内容会按视频、文章和播客分别排列。"
          actionLabel={canRefresh ? "更新来源" : undefined}
          onAction={canRefresh ? () => onRefreshSource(source.id) : undefined}
          secondaryLabel="返回订阅"
          onSecondary={onBack}
        />
      )}
    </>
  );
}

function SubscriptionsView({
  sources,
  selectedSourceIds,
  totalUnread,
  syncing,
  onAdd,
  onAssistant,
  onRefresh,
  onRefreshSource,
  onToggleSource,
  onSelectionChange,
  onRemoveSelected,
  onRemoveSource,
  onOpenDetails,
  onOpenSource,
  onSettings,
}: {
  sources: Source[];
  selectedSourceIds: string[];
  totalUnread: number;
  syncing: boolean;
  onAdd: () => void;
  onAssistant: () => void;
  onRefresh: () => void;
  onRefreshSource: (id: string) => void;
  onToggleSource: (id: string) => void;
  onSelectionChange: (ids: string[]) => void;
  onRemoveSelected: () => void;
  onRemoveSource: (source: Source) => void;
  onOpenDetails: (source: Source) => void;
  onOpenSource: (source: Source) => void;
  onSettings: (source: Source) => void;
}) {
  const liveCount = sources.filter((source) => source.enabled).length;
  const rssCount = sources.filter(
    (source) => source.feedUrl || source.refreshUrl || source.manualSubscription,
  ).length;
  const selectedIds = new Set(selectedSourceIds);
  const selectedCount = sources.filter((source) => selectedIds.has(source.id)).length;
  const allSelected = sources.length > 0 && selectedCount === sources.length;
  const selectAllRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = selectedCount > 0 && !allSelected;
    }
  }, [allSelected, selectedCount]);

  function toggleSourceSelection(sourceId: string, checked: boolean) {
    onSelectionChange(
      checked
        ? Array.from(new Set([...selectedSourceIds, sourceId]))
        : selectedSourceIds.filter((id) => id !== sourceId),
    );
  }

  return (
    <>
      <section className="page-heading compact-heading">
        <div>
          <p className="eyebrow">你的来源</p>
          <h1>订阅</h1>
          <p>只有你主动选择的来源，才会进入今日。</p>
        </div>
        <div className="heading-actions">
          <button className="secondary-button" type="button" onClick={onAssistant}>
            <Bookmark size={17} /> 浏览器助手
          </button>
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
              <span>新增内容</span>
            </div>
          </section>

          <section className="subscription-bulk-bar" aria-label="批量管理来源">
            <label className="source-select-all">
              <input
                ref={selectAllRef}
                type="checkbox"
                checked={allSelected}
                onChange={(event) =>
                  onSelectionChange(event.target.checked ? sources.map((source) => source.id) : [])
                }
              />
              <span>{allSelected ? "取消全选" : "全选来源"}</span>
            </label>
            <span className="selection-count" aria-live="polite">
              {selectedCount ? `已选择 ${selectedCount} 个来源` : "选择来源后可批量删除"}
            </span>
            <button
              className="danger-button"
              type="button"
              disabled={selectedCount === 0}
              onClick={onRemoveSelected}
            >
              <Trash2 size={16} /> 删除所选{selectedCount ? `（${selectedCount}）` : ""}
            </button>
          </section>

          <section className="source-list" aria-label="订阅来源列表">
            <div className="list-header" aria-hidden="true">
              <span>来源</span>
              <span>状态</span>
              <span>最近更新</span>
              <span>操作</span>
            </div>
            {sources.map((source) => (
              <article
                className={`source-row ${!source.enabled ? "is-paused" : ""} ${selectedIds.has(source.id) ? "is-selected" : ""}`}
                key={source.id}
              >
                <div className="source-main">
                  <label className="source-selection">
                    <input
                      type="checkbox"
                      checked={selectedIds.has(source.id)}
                      aria-label={`选择 ${source.name}`}
                      onChange={(event) =>
                        toggleSourceSelection(source.id, event.target.checked)
                      }
                    />
                  </label>
                  <SourceAvatar source={source} />
                  <div>
                    <button
                      className="source-name-button"
                      type="button"
                      onClick={() => onOpenDetails(source)}
                    >
                      <span>{source.name}</span>
                      <ChevronRight size={14} aria-hidden="true" />
                    </button>
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
                    source.feedUrl || source.refreshUrl || source.manualSubscription ? (
                      <span className="status-text success"><span />
                        {source.provider === "rsshub" ? " RSSHub 同步" : " 自动同步"}
                      </span>
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
                  <button
                    type="button"
                    aria-label={`在本站查看 ${source.name}`}
                    onClick={() => onOpenSource(source)}
                  >
                    <PanelTopOpen size={17} />
                  </button>
                  <button
                    type="button"
                    aria-label={`设置 ${source.name}`}
                    onClick={() => onSettings(source)}
                  >
                    <Settings size={17} />
                  </button>
                  {(source.feedUrl || source.refreshUrl || source.manualSubscription) && (
                    <button type="button" aria-label={`更新 ${source.name}`} onClick={() => onRefreshSource(source.id)}>
                      <RefreshCw size={17} />
                    </button>
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
            <LockKeyhole size={14} /> RSS 与已配置的 RSSHub 由本地站点按需读取；无法转换的平台仍以链接模式打开。
          </p>
        </>
      ) : (
        <EmptyState
          icon={Rss}
          title="还没有订阅"
          description="粘贴一个 RSS 或中文内容平台链接，从你已经信任的来源开始。"
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

function SourceSettingsModal({
  source,
  onClose,
  onFetchPreview,
  onSave,
}: {
  source: Source;
  onClose: () => void;
  onFetchPreview: (
    url: string,
    limit?: number,
    selections?: string[],
    manual?: RssHubManualSubscription,
  ) => Promise<PreviewSuccess>;
  onSave: (
    changes: {
      name: string;
      description: string;
      rsshubSelections: RssHubSelection[];
      bilibiliOpenMode?: "embedded" | "external";
    },
    preview?: PreviewSuccess,
  ) => void;
}) {
  const initialSelections =
    source.rsshubSelections ??
    (source.rsshubSelection
      ? [{ id: source.rsshubSelection, title: "已保存的内容范围" }]
      : []);
  const [name, setName] = useState(source.name);
  const [description, setDescription] = useState(source.description);
  const [bilibiliOpenMode, setBilibiliOpenMode] = useState<"embedded" | "external">(
    source.bilibiliOpenMode === "external" ? "external" : "embedded",
  );
  const [scopeOptions, setScopeOptions] = useState<PreviewSuccess["options"]>();
  const [selectedScopeIds, setSelectedScopeIds] = useState(
    initialSelections.map((selection) => selection.id),
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const canRediscoverScopes =
    source.provider === "rsshub" && Boolean(source.refreshUrl) && !source.manualSubscription;

  async function rediscoverScopes() {
    if (!source.refreshUrl) return;
    setLoading(true);
    setError("");
    try {
      const result = await onFetchPreview(source.refreshUrl, 20);
      if (result.mode !== "select" || !result.options?.length) {
        setError("这个链接目前只发现一个可用内容范围，无需重新选择。");
        return;
      }
      setScopeOptions(result.options);
      const availableIds = new Set(result.options.map((option) => option.id));
      setSelectedScopeIds((current) => current.filter((id) => availableIds.has(id)));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "暂时无法重新识别这个来源。");
    } finally {
      setLoading(false);
    }
  }

  async function saveSettings() {
    if (!name.trim()) {
      setError("显示名称不能为空。");
      return;
    }
    let preview: PreviewSuccess | undefined;
    let rsshubSelections = initialSelections;
    if (scopeOptions?.length) {
      if (!selectedScopeIds.length) {
        setError("至少保留一个内容范围。");
        return;
      }
      if (!source.refreshUrl) return;
      setLoading(true);
      setError("");
      try {
        preview = await onFetchPreview(source.refreshUrl, 12, selectedScopeIds);
        rsshubSelections =
          preview.source.rsshubSelections ??
          scopeOptions
            .filter((option) => selectedScopeIds.includes(option.id))
            .map(({ id, title, docsUrl }) => ({ id, title, docsUrl }));
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "保存内容范围前的验证失败了。");
        setLoading(false);
        return;
      }
      setLoading(false);
    }
    onSave(
      {
        name: name.trim(),
        description: description.trim(),
        rsshubSelections,
        bilibiliOpenMode:
          source.platform === "bilibili" ? bilibiliOpenMode : undefined,
      },
      preview,
    );
  }

  return (
    <Modal
      title={`设置 ${source.name}`}
      description="修改来源信息，或重新选择这个链接要持续更新的内容。"
      onClose={onClose}
      size="medium"
    >
      <div className="modal-content source-settings-content">
        <label>
          <span className="field-label">显示名称</span>
          <input value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <label>
          <span className="field-label">来源说明</span>
          <textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            rows={3}
            placeholder="写一句为什么订阅这个来源"
          />
        </label>

        <section className="source-origin-card">
          <span>原始公开链接</span>
          <code>{source.refreshUrl ?? source.feedUrl ?? source.url}</code>
          <small>为保证来源身份和已读记录稳定，设置中不会替换这个地址。</small>
        </section>

        {source.platform === "bilibili" && (
          <section className="source-video-open-settings">
            <div>
              <strong>视频打开方式</strong>
              <p>高清、登录与大会员播放能力通常需要在 Bilibili 网页中使用。</p>
            </div>
            <div className="source-open-mode-options" role="radiogroup" aria-label="视频打开方式">
              <label className={bilibiliOpenMode === "embedded" ? "is-selected" : ""}>
                <input
                  type="radio"
                  name="bilibili-open-mode"
                  value="embedded"
                  checked={bilibiliOpenMode === "embedded"}
                  onChange={() => setBilibiliOpenMode("embedded")}
                />
                <span><PanelTopOpen size={16} /></span>
                <div>
                  <strong>站内查看</strong>
                  <small>留在自选中阅读，返回路径更短</small>
                </div>
              </label>
              <label className={bilibiliOpenMode === "external" ? "is-selected" : ""}>
                <input
                  type="radio"
                  name="bilibili-open-mode"
                  value="external"
                  checked={bilibiliOpenMode === "external"}
                  onChange={() => setBilibiliOpenMode("external")}
                />
                <span><ExternalLink size={16} /></span>
                <div>
                  <strong>在新窗口打开 Bilibili</strong>
                  <small>使用平台登录、高清与大会员播放能力</small>
                </div>
              </label>
            </div>
          </section>
        )}

        {initialSelections.length > 0 && (
          <section className="source-scope-settings">
            <div className="source-scope-heading">
              <div>
                <strong>订阅的内容范围</strong>
                <p>多个范围仍然属于同一个来源。</p>
              </div>
              {canRediscoverScopes && (
                <button type="button" disabled={loading} onClick={() => void rediscoverScopes()}>
                  <RefreshCw className={loading ? "is-spinning" : ""} size={15} />
                  重新选择内容范围
                </button>
              )}
            </div>

            {!scopeOptions?.length ? (
              <div className="current-scope-list">
                {initialSelections.map((selection) => (
                  <span key={selection.id}>{selection.title}</span>
                ))}
              </div>
            ) : (
              <div className="source-settings-scope-list">
                {scopeOptions.map((option) => {
                  const checked = selectedScopeIds.includes(option.id);
                  return (
                    <label className={checked ? "is-selected" : ""} key={option.id}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(event) =>
                          setSelectedScopeIds((current) =>
                            event.target.checked
                              ? [...current, option.id]
                              : current.filter((id) => id !== option.id),
                          )
                        }
                      />
                      <span>{checked && <Check size={13} />}</span>
                      <div><strong>{option.title}</strong><small>{option.description}</small></div>
                    </label>
                  );
                })}
              </div>
            )}
            <p className="source-scope-note">
              修改后不会删除旧内容；以后获取的内容仍写入「{source.name}」。
            </p>
          </section>
        )}

        {error && <p className="field-error" role="alert">{error}</p>}
      </div>
      <div className="modal-footer simple-footer">
        <button className="quiet-button" type="button" onClick={onClose}>取消</button>
        <button
          className="primary-button"
          type="button"
          disabled={loading || !name.trim()}
          onClick={() => void saveSettings()}
        >
          {loading ? <RefreshCw className="is-spinning" size={16} /> : <Check size={16} />}
          保存设置
        </button>
      </div>
    </Modal>
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
  onFetchPreview: (
    url: string,
    limit?: number,
    selections?: string[],
    manual?: RssHubManualSubscription,
  ) => Promise<PreviewSuccess>;
  onConfirm: (preview: PreviewSuccess, name: string, includeRecent: boolean) => void;
}) {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<PreviewSuccess | null>(null);
  const [selectionPreview, setSelectionPreview] = useState<PreviewSuccess | null>(null);
  const [selectedOptionIds, setSelectedOptionIds] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [includeRecent, setIncludeRecent] = useState(true);
  const [wechatAdvancedOpen, setWechatAdvancedOpen] = useState(false);
  const [wechatKind, setWechatKind] = useState<RssHubManualSubscription["kind"]>("wechat-uread");
  const [wechatUserid, setWechatUserid] = useState("");
  const [wechatBiz, setWechatBiz] = useState("");
  const [wechatHid, setWechatHid] = useState("");
  const [wechatCid, setWechatCid] = useState("");
  const [wechat2RssId, setWechat2RssId] = useState("");

  const usesWechatParameters = wechatAdvancedOpen;

  function resetResult() {
    setError("");
    setPreview(null);
    setSelectionPreview(null);
    setSelectedOptionIds([]);
  }

  function toggleWechatAdvanced() {
    setWechatAdvancedOpen((current) => !current);
    setUrl("");
    setName("");
    resetResult();
  }

  function wechatManual(): RssHubManualSubscription | undefined {
    if (!wechatAdvancedOpen) return undefined;
    if (wechatKind === "wechat-uread") {
      return { kind: wechatKind, userid: wechatUserid.trim() };
    }
    if (wechatKind === "wechat-mp") {
      return {
        kind: wechatKind,
        biz: wechatBiz.trim(),
        hid: wechatHid.trim(),
        cid: wechatCid.trim() || undefined,
      };
    }
    return { kind: wechatKind, id: wechat2RssId.trim() };
  }

  function manualIsComplete(manual?: RssHubManualSubscription) {
    if (!manual) return false;
    if (manual.kind === "wechat-uread") return Boolean(manual.userid);
    if (manual.kind === "wechat-mp") return Boolean(manual.biz && manual.hid);
    return Boolean(manual.id);
  }

  async function loadPreview(selections?: string[]) {
    const trimmed = url.trim();
    const manual = wechatManual();
    if (!usesWechatParameters && !trimmed) {
      setError("请先粘贴一个中文内容平台、网站或 RSS 地址。");
      return;
    }
    if (usesWechatParameters && !manualIsComplete(manual)) {
      setError("请填写这个微信公众号订阅方式所需的参数。");
      return;
    }

    if (!selections?.length) {
      const duplicate = manual
        ? existingSources.find(
            (source) => JSON.stringify(source.manualSubscription) === JSON.stringify(manual),
          )
        : existingSources.find(
            (source) =>
              source.url === trimmed ||
              source.feedUrl === trimmed ||
              source.refreshUrl === trimmed,
          );
      if (duplicate) {
        setError(`你已经订阅「${duplicate.name}」了。`);
        return;
      }
    }

    setError("");
    setLoading(true);
    try {
      const result = await onFetchPreview(trimmed, 12, selections, manual);
      setPreview(result);
      if (result.mode === "select") {
        setSelectionPreview(result);
        setSelectedOptionIds([]);
      } else {
        setName(result.source.title);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "暂时没认出这个地址，请重试。");
    } finally {
      setLoading(false);
    }
  }

  async function identify() {
    setPreview(null);
    setSelectionPreview(null);
    setSelectedOptionIds([]);
    await loadPreview();
  }

  return (
    <Modal
      title="添加订阅"
      description="粘贴一个你已经信任的来源。链接只用于识别与按需更新。"
      onClose={onClose}
      size="large"
    >
      <div className="modal-content add-source-content">
        <div className="parser-entry-heading">
          <div>
            <label className="field-label">链接或 RSS</label>
            <p>粘贴一次即可自动识别网站、Feed 和中文内容平台。</p>
          </div>
          <span><Sparkles size={15} /> 自动识别</span>
        </div>

        <section className="supported-platforms" aria-labelledby="supported-platforms-title">
          <div className="supported-platforms-heading">
            <strong id="supported-platforms-title">已支持的平台</strong>
            <span>无需预先选择</span>
          </div>
          <div className="supported-platform-list" role="list">
            {supportedPlatforms.map((platform) => (
              <span key={platform.id} role="listitem">{platform.label}</span>
            ))}
          </div>
          <button className="wechat-advanced-toggle" type="button" onClick={toggleWechatAdvanced}>
            <span>
              <strong>微信公众号高级设置</strong>
              <small>使用公众号 ID、Biz / HID 或 Wechat2RSS ID</small>
            </span>
            <ChevronRight size={17} className={wechatAdvancedOpen ? "is-open" : ""} />
          </button>
        </section>

        {wechatAdvancedOpen && (
          <section className="wechat-entry" aria-labelledby="wechat-entry-title">
            <div>
              <label className="field-label" id="wechat-entry-title">微信公众号高级设置</label>
              <p>普通文章链接不能可靠推导历史订阅，可改用 RSSHub 支持的公众号标识。</p>
            </div>
            <select
              value={wechatKind}
              onChange={(event) => {
                setWechatKind(event.target.value as typeof wechatKind);
                resetResult();
              }}
            >
              <option value="wechat-uread">优读公众号 ID</option>
              <option value="wechat-mp">公众号栏目 Biz / HID</option>
              <option value="wechat-wechat2rss">Wechat2RSS ID</option>
            </select>
            {wechatKind === "wechat-uread" && (
              <label>
                <span>公众号 ID</span>
                <input value={wechatUserid} onChange={(event) => { setWechatUserid(event.target.value); resetResult(); }} placeholder="例如 shensing" />
              </label>
            )}
            {wechatKind === "wechat-mp" && (
              <div className="wechat-parameter-grid">
                <label><span>Biz</span><input value={wechatBiz} onChange={(event) => { setWechatBiz(event.target.value); resetResult(); }} placeholder="MzA3...==" /></label>
                <label><span>HID</span><input value={wechatHid} onChange={(event) => { setWechatHid(event.target.value); resetResult(); }} placeholder="16" inputMode="numeric" /></label>
                <label><span>CID（可选）</span><input value={wechatCid} onChange={(event) => { setWechatCid(event.target.value); resetResult(); }} inputMode="numeric" /></label>
              </div>
            )}
            {wechatKind === "wechat-wechat2rss" && (
              <label>
                <span>Wechat2RSS ID</span>
                <input value={wechat2RssId} onChange={(event) => { setWechat2RssId(event.target.value); resetResult(); }} placeholder="十六进制来源 ID" />
              </label>
            )}
          </section>
        )}

        {!usesWechatParameters && (
          <>
            <label className="field-label" htmlFor="source-url">订阅地址或分享文案</label>
            <div className={`url-field ${error ? "has-error" : ""}`}>
              <Link2 size={18} />
              <input
                id="source-url"
                value={url}
                onChange={(event) => {
                  setUrl(event.target.value);
                  resetResult();
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void identify();
                }}
                placeholder="粘贴 URL 或包含一个 URL 的分享文案"
                autoComplete="url"
                inputMode="url"
              />
              {url && (
                <button type="button" aria-label="清空地址" onClick={() => { setUrl(""); resetResult(); }}>
                  <X size={16} />
                </button>
              )}
            </div>
          </>
        )}
        {error && <p className="field-error" role="alert">{error}</p>}

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
              {preview.mode === "select"
                ? `找到 ${preview.options?.length ?? 0} 种订阅方式`
                : preview.mode === "live"
                ? preview.source.provider === "rsshub"
                  ? "已通过 RSSHub 识别可同步来源"
                  : "已识别可同步的订阅源"
                : `已识别${preview.source.platformLabel ?? "平台"}链接`}
            </div>
            {preview.mode === "select" ? (
              <div className="subscription-choice-panel">
                <div>
                  <strong>选择要订阅的内容</strong>
                  <p>{preview.source.description}</p>
                </div>
                <div className="subscription-choice-list">
                  {preview.options?.map((option) => (
                    <label
                      className={selectedOptionIds.includes(option.id) ? "is-selected" : ""}
                      key={option.id}
                    >
                      <input
                        type="checkbox"
                        checked={selectedOptionIds.includes(option.id)}
                        disabled={loading}
                        onChange={(event) => {
                          setSelectedOptionIds((current) =>
                            event.target.checked
                              ? [...current, option.id]
                              : current.filter((id) => id !== option.id),
                          );
                        }}
                      />
                      <span className="scope-choice-check">
                        {selectedOptionIds.includes(option.id) && <Check size={13} />}
                      </span>
                      <div><strong>{option.title}</strong><p>{option.description}</p></div>
                    </label>
                  ))}
                </div>
                <p className="scope-selection-count">
                  已选择 {selectedOptionIds.length} 项；这些内容会合并为一个来源。
                </p>
              </div>
            ) : (
              <>
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

                {preview.source.provider === "rsshub" && (
                  <div className="link-mode-note">
                    <Rss size={16} />
                    <p>
                      使用 {preview.source.rsshubSelections?.length ?? 1} 个 RSSHub 内容范围
                      {preview.source.routeTitle ? `（${preview.source.routeTitle}）` : ""}
                      ；它们作为一个来源保存，实例地址与访问密钥不会进入浏览器。
                    </p>
                  </div>
                )}

                {Boolean(preview.source.rsshubSelections?.length) && (
                  <div className="selected-scope-summary">
                    <div>
                      <strong>已选内容范围</strong>
                      <div>
                        {preview.source.rsshubSelections?.map((selection) => (
                          <span key={selection.id}>{selection.title}</span>
                        ))}
                      </div>
                    </div>
                    {selectionPreview && (
                      <button type="button" onClick={() => setPreview(selectionPreview)}>
                        重新选择
                      </button>
                    )}
                  </div>
                )}

                {preview.mode === "link-only" && Boolean(preview.options?.length) && (
                  <div className="alternate-choice-block">
                    <strong>尝试其他订阅内容</strong>
                    <div>
                      {preview.options?.map((option) => (
                        <button key={option.id} type="button" disabled={loading} onClick={() => void loadPreview([option.id])}>
                          {option.title}
                        </button>
                      ))}
                    </div>
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
                        <strong>保留最近 3 条作为频道历史</strong>
                        <p>可以查看，但不会因为刚订阅就标为新增</p>
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
              </>
            )}
          </div>
        )}
      </div>

      <div className="modal-footer">
        <p><LockKeyhole size={13} /> 订阅记录只保存在这台设备</p>
        <div>
          <button className="quiet-button" type="button" onClick={onClose}>取消</button>
          {preview && preview.mode !== "select" ? (
            <button className="primary-button" type="button" disabled={!name.trim()} onClick={() => onConfirm(preview, name, includeRecent)}>
              <Plus size={16} /> 确认订阅
            </button>
          ) : (
            <button
              className="primary-button"
              type="button"
              disabled={
                loading ||
                (preview?.mode === "select"
                  ? selectedOptionIds.length === 0
                  : usesWechatParameters
                    ? !manualIsComplete(wechatManual())
                    : !url.trim())
              }
              onClick={() =>
                void (preview?.mode === "select"
                  ? loadPreview(selectedOptionIds)
                  : identify())
              }
            >
              {loading ? <RefreshCw className="is-spinning" size={16} /> : <ArrowRight size={16} />}
              {preview?.mode === "select"
                ? selectedOptionIds.length
                  ? `预览已选 ${selectedOptionIds.length} 项`
                  : "至少选择一项"
                : "识别订阅源"}
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
                <button type="button" onClick={() => onOpenItem(item)}>
                  {item.title}
                </button>
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

function BrowserAssistantModal({
  queue,
  data,
  importing,
  onClose,
  onConfirm,
}: {
  queue: AssistantQueueItem[];
  data: AppData;
  importing: boolean;
  onClose: () => void;
  onConfirm: (selection: AssistantImportSelection) => void;
}) {
  const clipItems = queue.filter(
    (item): item is Extract<AssistantQueueItem, { kind: "clip" }> => item.kind === "clip",
  );
  const laterCollection = data.collections.find((collection) => collection.isSystem);
  const userCollections = data.collections.filter(
    (collection) => collection.owned && !collection.isSystem,
  );
  const existingUrls = new Set(
    data.sources.filter((source) => !source.archived).map((source) => comparableSourceUrl(source.url)),
  );
  const sourceRows = queue.flatMap((item) => {
    if (item.kind === "source") {
      const normalized = comparableSourceUrl(item.candidate.url);
      return [{
        key: `${item.id}:${normalized}`,
        queueId: item.id,
        candidate: item.candidate,
        platform: "网页来源",
        duplicate: existingUrls.has(normalized),
        newlyFollowed: true,
      }];
    }
    if (item.kind !== "follow-batch") return [];
    const addedIds = new Set(item.added.map((candidate) => candidate.externalId));
    return item.candidates.map((candidate) => {
      const normalized = comparableSourceUrl(candidate.url);
      return {
        key: `${item.id}:${normalized}`,
        queueId: item.id,
        candidate,
        platform: "B站",
        duplicate: existingUrls.has(normalized),
        newlyFollowed: item.previousCount === 0 || addedIds.has(candidate.externalId),
      };
    });
  });
  const removed = queue.flatMap((item) => item.kind === "follow-batch" ? item.removed : []);
  const [selectedClipIds, setSelectedClipIds] = useState(() => clipItems.map((item) => item.id));
  const [selectedSourceKeys, setSelectedSourceKeys] = useState(() =>
    sourceRows
      .filter((row) => !row.duplicate && row.newlyFollowed)
      .map((row) => row.key),
  );
  const [destinations, setDestinations] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      clipItems.map((item) => [
        item.id,
        item.destination === "later"
          ? laterCollection?.id ?? ""
          : userCollections[0]?.id ?? "",
      ]),
    ),
  );

  const missingDestination = clipItems.some(
    (item) => selectedClipIds.includes(item.id) && !destinations[item.id],
  );
  const selectedCount = selectedClipIds.length + selectedSourceKeys.length;

  return (
    <Modal
      title="来自浏览器助手"
      description="先检查再保存；只有确认的内容会写入这台设备。"
      onClose={onClose}
      size="large"
    >
      <div className="modal-content assistant-import-content">
        {clipItems.length > 0 && (
          <section className="assistant-import-section">
            <div className="assistant-import-heading">
              <div><strong>网页收藏</strong><p>{clipItems.length} 条待处理内容</p></div>
              <button
                type="button"
                onClick={() =>
                  setSelectedClipIds(
                    selectedClipIds.length === clipItems.length ? [] : clipItems.map((item) => item.id),
                  )
                }
              >
                {selectedClipIds.length === clipItems.length ? "取消全选" : "全选"}
              </button>
            </div>
            <div className="assistant-import-list">
              {clipItems.map((item) => {
                const checked = selectedClipIds.includes(item.id);
                const destinationOptions = item.destination === "later"
                  ? data.collections.filter((collection) => collection.id === laterCollection?.id)
                  : userCollections;
                return (
                  <article className={checked ? "is-selected" : ""} key={item.id}>
                    <label>
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={importing}
                        onChange={(event) =>
                          setSelectedClipIds((current) =>
                            event.target.checked
                              ? [...current, item.id]
                              : current.filter((id) => id !== item.id),
                          )
                        }
                      />
                      <span className="assistant-check">{checked && <Check size={13} />}</span>
                      <span><strong>{item.page.title}</strong><small>{item.page.siteName ?? new URL(item.page.url).hostname}</small></span>
                    </label>
                    <select
                      aria-label={`选择「${item.page.title}」的合集`}
                      value={destinations[item.id] ?? ""}
                      disabled={!checked || importing}
                      onChange={(event) => setDestinations((current) => ({ ...current, [item.id]: event.target.value }))}
                    >
                      <option value="">选择合集</option>
                      {destinationOptions.map((collection) => (
                        <option key={collection.id} value={collection.id}>{collection.title}</option>
                      ))}
                    </select>
                    {item.destination === "collection" && !userCollections.length && (
                      <p className="field-error">请先关闭窗口并新建一个合集，队列不会丢失。</p>
                    )}
                    {item.page.selection && <blockquote>{item.page.selection}</blockquote>}
                  </article>
                );
              })}
            </div>
          </section>
        )}

        {sourceRows.length > 0 && (
          <section className="assistant-import-section">
            <div className="assistant-import-heading">
              <div><strong>订阅来源</strong><p>{sourceRows.length} 个候选，自动排除已有来源</p></div>
              <button
                type="button"
                onClick={() => {
                  const available = sourceRows.filter((row) => !row.duplicate).map((row) => row.key);
                  setSelectedSourceKeys(selectedSourceKeys.length === available.length ? [] : available);
                }}
              >
                全选可导入项
              </button>
            </div>
            <div className="assistant-source-list">
              {sourceRows.map((row) => {
                const checked = selectedSourceKeys.includes(row.key);
                return (
                  <label className={checked ? "is-selected" : ""} key={row.key}>
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={row.duplicate || importing}
                      onChange={(event) =>
                        setSelectedSourceKeys((current) =>
                          event.target.checked
                            ? [...current, row.key]
                            : current.filter((key) => key !== row.key),
                        )
                      }
                    />
                    <span className="assistant-check">{checked && <Check size={13} />}</span>
                    <span><strong>{row.candidate.name}</strong><small>{row.platform} · {row.candidate.url}</small></span>
                    <em>{row.duplicate ? "已订阅" : row.newlyFollowed ? "新增" : "仍在关注"}</em>
                  </label>
                );
              })}
            </div>
          </section>
        )}

        {removed.length > 0 && (
          <section className="assistant-removed-note">
            <ShieldCheck size={18} />
            <div>
              <strong>{removed.length} 个账号在本轮不再出现</strong>
              <p>取消关注只供确认，不会自动删除：{removed.slice(0, 6).map((item) => item.name).join("、")}{removed.length > 6 ? "…" : ""}</p>
            </div>
          </section>
        )}
      </div>
      <div className="modal-footer">
        <p><LockKeyhole size={13} /> 队列与配对信息只保存在本机</p>
        <div>
          <button className="quiet-button" type="button" onClick={onClose} disabled={importing}>稍后处理</button>
          <button
            className="primary-button"
            type="button"
            disabled={importing || selectedCount === 0 || missingDestination}
            onClick={() => onConfirm({ clipIds: selectedClipIds, sourceKeys: selectedSourceKeys, destinations })}
          >
            {importing ? <RefreshCw className="is-spinning" size={16} /> : <CheckCheck size={16} />}
            {importing ? "正在导入" : `确认导入 ${selectedCount} 项`}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function SettingsModal({
  data,
  assistantPairingCode,
  assistantChecking,
  onClose,
  onExport,
  onImport,
  onGenerateAssistantCode,
  onCopyAssistantCode,
  onRevokeAssistantCode,
  onCheckAssistant,
  onImportAssistant,
  onClear,
  onToggleMatching,
  onToggleCollectionUpdates,
}: {
  data: AppData;
  assistantPairingCode: string;
  assistantChecking: boolean;
  onClose: () => void;
  onExport: () => void;
  onImport: () => void;
  onGenerateAssistantCode: () => void;
  onCopyAssistantCode: () => void;
  onRevokeAssistantCode: () => void;
  onCheckAssistant: () => void;
  onImportAssistant: () => void;
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
            <p>订阅、查看记录、新增基线、合集和发现偏好都保存在浏览器中。自选不要求登录，也不会把这些数据上传。</p>
          </div>
        </section>

        <section className="session-card">
          <div className="session-card-icon"><PanelTopOpen size={20} /></div>
          <div>
            <div className="settings-title-row">
              <h3>已打开的外部站点</h3>
              <span>{data.platformSessions.length} 个站点已在本站打开</span>
            </div>
            <p>
              自选只记录站点地址和最近打开时间，不读取、保存或导出密码与 Cookie。登录状态能否在内嵌页面复用，由浏览器隐私设置和来源平台共同决定。
            </p>
          </div>
        </section>

        <section className="settings-section assistant-settings-section">
          <div className="settings-title-row">
            <div>
              <h3>浏览器助手</h3>
              <p>收藏当前网页、订阅来源，或从 B站关注页批量导入。</p>
            </div>
            <span>{assistantPairingCode ? "已生成配对码" : "尚未配对"}</span>
          </div>
          <div className="assistant-privacy-note">
            <ShieldCheck size={18} />
            <p>扩展不会读取密码或 Cookie；只有你主动点击后，公开页面信息才会进入本地待处理队列。</p>
          </div>
          {assistantPairingCode ? (
            <div className="assistant-pairing-panel">
              <label htmlFor="assistant-pairing-code">配对码</label>
              <div>
                <input id="assistant-pairing-code" value={assistantPairingCode} readOnly />
                <button type="button" onClick={onCopyAssistantCode}>复制</button>
              </div>
              <p>将配对码粘贴到扩展的连接设置。它独立保存在本机，不会进入 JSON 备份。</p>
            </div>
          ) : (
            <button className="secondary-button assistant-generate-button" type="button" onClick={onGenerateAssistantCode}>
              <Link2 size={16} /> 生成本地配对码
            </button>
          )}
          <div className="assistant-setting-actions">
            <button type="button" onClick={onCheckAssistant} disabled={assistantChecking || !assistantPairingCode}>
              <RefreshCw className={assistantChecking ? "is-spinning" : ""} size={16} />
              {assistantChecking ? "正在检查" : "检查待处理内容"}
            </button>
            <button type="button" onClick={onImportAssistant}>
              <Upload size={16} /> 导入助手 JSON
            </button>
            {assistantPairingCode && (
              <button className="danger-text-button" type="button" onClick={onRevokeAssistantCode}>
                重新配对 / 撤销
              </button>
            )}
          </div>
          <p className="assistant-install-note">
            开发版扩展位于仓库 <code>browser-extension/</code>，在 Chrome 或 Edge 中选择“加载已解压的扩展程序”。
          </p>
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
  onOpenItem,
  onDiscover,
}: {
  item?: ContentItem;
  source?: Source;
  remaining: number;
  onClose: () => void;
  onMarkRead: (id: string, read: boolean) => void;
  onOpenItem: (item: ContentItem) => void;
  onDiscover: () => void;
}) {
  const opensExternally = Boolean(item && opensBilibiliVideoExternally(source, item));
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
              <button className="primary-button" type="button" onClick={() => onOpenItem(item)}>
                {opensExternally ? "打开 Bilibili" : "在本站查看"}
                {opensExternally ? <ExternalLink size={16} /> : <PanelTopOpen size={16} />}
              </button>
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
  const [failedImageUrl, setFailedImageUrl] = useState("");

  return (
    <span className={`source-avatar tone-${source?.tone ?? "ink"} avatar-${size}`} aria-hidden="true">
      {source?.imageUrl && source.imageUrl !== failedImageUrl ? (
        <img
          src={source.imageUrl}
          alt=""
          referrerPolicy="no-referrer"
          onError={() => setFailedImageUrl(source.imageUrl ?? "")}
        />
      ) : source?.initials ?? "源"}
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
