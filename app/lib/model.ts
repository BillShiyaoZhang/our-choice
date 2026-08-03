export type View = "today" | "discover" | "collections" | "subscriptions";

export type ContentType = "video" | "podcast" | "article";

export type Platform =
  | "bilibili"
  | "wechat"
  | "zhihu"
  | "xiaohongshu"
  | "douyin"
  | "kuaishou"
  | "weibo"
  | "xiaoyuzhou"
  | "toutiao"
  | "baijiahao"
  | "douban"
  | "ximalaya"
  | "rss"
  | "podcast"
  | "web";

export type VisualTone =
  | "forest"
  | "clay"
  | "ocean"
  | "sun"
  | "plum"
  | "ink";

export type RssHubManualSubscription =
  | { kind: "wechat-uread"; userid: string }
  | { kind: "wechat-mp"; biz: string; hid: string; cid?: string }
  | { kind: "wechat-wechat2rss"; id: string };

export interface RssHubSelection {
  id: string;
  title: string;
  docsUrl?: string;
}

export interface Source {
  id: string;
  name: string;
  description: string;
  /** Public source/avatar image URL; UI falls back to initials when unavailable. */
  imageUrl?: string;
  platform: Platform;
  url: string;
  feedUrl?: string;
  /** Original public page re-resolved through RSSHub Radar on every refresh. */
  refreshUrl?: string;
  provider?: "rsshub";
  /** Stable candidate id, revalidated against current Radar rules on refresh. */
  rsshubSelection?: string;
  /** One or more Radar scopes combined and managed as this single source. */
  rsshubSelections?: RssHubSelection[];
  /** How videos from a Bilibili source open. Missing legacy values mean embedded. */
  bilibiliOpenMode?: "embedded" | "external";
  /** The last RSSHub feed was matched back to this Bilibili profile's MID. */
  identityVerified?: boolean;
  /** Non-secret identifiers for an allowlisted manual RSSHub route. */
  manualSubscription?: RssHubManualSubscription;
  initials: string;
  tone: VisualTone;
  enabled: boolean;
  archived?: boolean;
  lastSyncLabel: string;
  unreadCount: number;
  /** When this source joined Our Choice. Content at or before this baseline is history. */
  addedAt?: string;
  baselineAt?: string;
  /** Feed item ids observed at the baseline or during later refreshes. */
  knownItemIds?: string[];
  lastOpenedAt?: string;
  /** Source was discovered and confirmed through the optional local browser helper. */
  importedFrom?: "browser-extension";
  /** Platform-stable public identifier, such as a Bilibili MID. */
  externalId?: string;
  importBatchId?: string;
  isSystem?: boolean;
  isDemo?: boolean;
}

export interface ContentItem {
  id: string;
  sourceId: string;
  title: string;
  summary: string;
  type: ContentType;
  url: string;
  publishedAt: string;
  /** False when the source omitted its publication date and publishedAt is only a discovery fallback. */
  publishedAtReliable?: boolean;
  publishedLabel: string;
  dateGroup: "今天" | "昨天" | "更早";
  duration: string;
  read: boolean;
  /** New means discovered after the source baseline; viewing clears the effective new state. */
  isNew?: boolean;
  discoveredAt?: string;
  viewedAt?: string;
  /** Metadata for a user-initiated browser capture; never contains credentials. */
  capturedAt?: string;
  selectionText?: string;
  capturedFrom?: "browser-extension";
  thumbnailUrl?: string;
  tone: VisualTone;
  visualLabel: string;
  collectionIds: string[];
  isDemo?: boolean;
}

export interface Collection {
  id: string;
  title: string;
  description: string;
  itemIds: string[];
  tone: VisualTone;
  owned: boolean;
  curator: string;
  updatedLabel: string;
  muted?: boolean;
  isSystem?: boolean;
  isDemo?: boolean;
}

export interface SuggestedCollection {
  id: string;
  title: string;
  description: string;
  curator: string;
  itemCount: number;
  tone: VisualTone;
  tags: string[];
  reason: string;
  distance: "near" | "step" | "random";
  sampleTitles: string[];
}

export interface AppSettings {
  localMatching: boolean;
  includeCollectionUpdates: boolean;
  hiddenSuggestionIds: string[];
  welcomeDismissed: boolean;
}

export interface PlatformSession {
  origin: string;
  platform: Platform;
  firstOpenedAt: string;
  lastOpenedAt: string;
}

export interface AppData {
  version: 2;
  sources: Source[];
  items: ContentItem[];
  collections: Collection[];
  /** Non-sensitive metadata only. Credentials and cookies remain browser-managed. */
  platformSessions: PlatformSession[];
  settings: AppSettings;
}

export const seedSources: Source[] = [
  {
    id: "source-storm",
    name: "影视飓风",
    description: "影像技术、创作实验与对世界的好奇",
    platform: "bilibili",
    url: "https://space.bilibili.com/946974",
    initials: "影",
    tone: "ocean",
    enabled: true,
    lastSyncLabel: "12 分钟前",
    unreadCount: 2,
    isDemo: true,
  },
  {
    id: "source-latte",
    name: "半拿铁｜商业沉浮录",
    description: "用故事讲清商业世界的来龙去脉",
    platform: "podcast",
    url: "https://www.xiaoyuzhoufm.com/",
    initials: "半",
    tone: "clay",
    enabled: true,
    lastSyncLabel: "26 分钟前",
    unreadCount: 1,
    isDemo: true,
  },
  {
    id: "source-sspai",
    name: "少数派",
    description: "高效工作，品质生活",
    platform: "rss",
    url: "https://sspai.com/",
    feedUrl: "https://sspai.com/feed",
    initials: "少",
    tone: "ink",
    enabled: true,
    lastSyncLabel: "今天 08:40",
    unreadCount: 2,
    isDemo: true,
  },
  {
    id: "source-yixi",
    name: "一席",
    description: "听君一席话，胜读十年书",
    platform: "bilibili",
    url: "https://space.bilibili.com/14070153",
    initials: "一",
    tone: "forest",
    enabled: true,
    lastSyncLabel: "昨天 21:10",
    unreadCount: 1,
    isDemo: true,
  },
  {
    id: "source-etw",
    name: "声东击西",
    description: "从世界的另一边，看见更多可能",
    platform: "podcast",
    url: "https://www.xiaoyuzhoufm.com/",
    initials: "声",
    tone: "plum",
    enabled: true,
    lastSyncLabel: "昨天 18:22",
    unreadCount: 1,
    isDemo: true,
  },
];

export const seedItems: ContentItem[] = [
  {
    id: "item-island",
    sourceId: "source-storm",
    title: "把一座海岛拍成一封信：我们如何记录正在消失的海岸线",
    summary: "一次关于影像、时间和地方记忆的长途创作，也是一份克制的拍摄复盘。",
    type: "video",
    url: "https://search.bilibili.com/all?keyword=%E5%BD%B1%E8%A7%86%E9%A3%93%E9%A3%8E%20%E6%B5%B7%E5%B2%9B",
    publishedAt: "2026-08-01T09:42:00+08:00",
    publishedLabel: "18 分钟前",
    dateGroup: "今天",
    duration: "18:42",
    read: false,
    tone: "ocean",
    visualLabel: "ISLAND / 01",
    collectionIds: [],
    isDemo: true,
  },
  {
    id: "item-question",
    sourceId: "source-yixi",
    title: "AI 之后，我们为什么更要学会提出一个好问题",
    summary: "答案变得廉价以后，理解问题、辨认边界和保持判断，反而成为更珍贵的能力。",
    type: "video",
    url: "https://search.bilibili.com/all?keyword=%E4%B8%80%E5%B8%AD%20AI%20%E9%97%AE%E9%A2%98",
    publishedAt: "2026-08-01T08:30:00+08:00",
    publishedLabel: "1 小时前",
    dateGroup: "今天",
    duration: "24:16",
    read: false,
    tone: "forest",
    visualLabel: "ASK BETTER",
    collectionIds: ["collection-boundary"],
    isDemo: true,
  },
  {
    id: "item-reading-room",
    sourceId: "source-sspai",
    title: "一台电脑，如何成为真正属于你的阅读室",
    summary: "从信息入口、稍后读到长期归档，重新搭建一个不依赖算法的个人阅读工作流。",
    type: "article",
    url: "https://sspai.com/",
    publishedAt: "2026-08-01T07:50:00+08:00",
    publishedLabel: "2 小时前",
    dateGroup: "今天",
    duration: "8 分钟",
    read: false,
    tone: "ink",
    visualLabel: "READ / OWN",
    collectionIds: ["collection-boundary"],
    isDemo: true,
  },
  {
    id: "item-company",
    sourceId: "source-latte",
    title: "一家公司消失前，会发出哪些声音？",
    summary: "从三个商业周期的真实案例出发，聊聊增长叙事背后被忽略的信号。",
    type: "podcast",
    url: "https://www.xiaoyuzhoufm.com/",
    publishedAt: "2026-08-01T07:05:00+08:00",
    publishedLabel: "3 小时前",
    dateGroup: "今天",
    duration: "56 分钟",
    read: false,
    tone: "clay",
    visualLabel: "EP. 142",
    collectionIds: [],
    isDemo: true,
  },
  {
    id: "item-city",
    sourceId: "source-yixi",
    title: "城市里的野生邻居：当动物重新学会与我们相处",
    summary: "一位城市生态研究者的十年观察：我们怎样共享同一片街区，而不只是彼此驱赶。",
    type: "video",
    url: "https://search.bilibili.com/all?keyword=%E4%B8%80%E5%B8%AD%20%E5%9F%8E%E5%B8%82%E7%94%9F%E6%80%81",
    publishedAt: "2026-07-31T21:10:00+08:00",
    publishedLabel: "昨天 21:10",
    dateGroup: "昨天",
    duration: "31:08",
    read: true,
    tone: "sun",
    visualLabel: "CITY / WILD",
    collectionIds: ["collection-weekend"],
    isDemo: true,
  },
  {
    id: "item-distance",
    sourceId: "source-etw",
    title: "远方不是滤镜：重新理解旅行、凝视与地方感",
    summary: "旅行写作如何不把他人的生活变成背景？一场关于观看伦理的轻盈对谈。",
    type: "podcast",
    url: "https://www.xiaoyuzhoufm.com/",
    publishedAt: "2026-07-31T18:22:00+08:00",
    publishedLabel: "昨天 18:22",
    dateGroup: "昨天",
    duration: "47 分钟",
    read: false,
    tone: "plum",
    visualLabel: "EAST / WEST",
    collectionIds: ["collection-weekend"],
    isDemo: true,
  },
  {
    id: "item-repair",
    sourceId: "source-sspai",
    title: "修而不是换：我的电子设备延寿手记",
    summary: "一次从换电池、清灰到重装系统的周末实验，以及关于消费欲望的意外答案。",
    type: "article",
    url: "https://sspai.com/",
    publishedAt: "2026-07-30T15:20:00+08:00",
    publishedLabel: "2 天前",
    dateGroup: "更早",
    duration: "6 分钟",
    read: true,
    tone: "forest",
    visualLabel: "KEEP / FIX",
    collectionIds: [],
    isDemo: true,
  },
];

export const seedCollections: Collection[] = [
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
  {
    id: "collection-boundary",
    title: "数字生活的边界",
    description: "技术如何改变注意力、选择与我们理解世界的方式。",
    itemIds: ["item-question", "item-reading-room"],
    tone: "forest",
    owned: true,
    curator: "我",
    updatedLabel: "今天",
    isDemo: true,
  },
  {
    id: "collection-weekend",
    title: "周末慢下来",
    description: "适合留出一段完整时间，安静看完与听完的内容。",
    itemIds: ["item-city", "item-distance"],
    tone: "clay",
    owned: true,
    curator: "我",
    updatedLabel: "昨天",
    isDemo: true,
  },
];

export const suggestedCollections: SuggestedCollection[] = [
  {
    id: "suggestion-tools",
    title: "工具之后，仍然是人",
    description: "不追逐新品，把工具放回生活与工作真实语境里的 16 篇内容。",
    curator: "林间",
    itemCount: 16,
    tone: "forest",
    tags: ["数字生活", "设计", "技术伦理"],
    reason: "与你在本机保存的「数字生活」和「设计」主题相近",
    distance: "near",
    sampleTitles: [
      "效率工具没有告诉你的事",
      "把复杂留给系统，把清晰还给人",
      "我们究竟在为什么升级设备",
    ],
  },
  {
    id: "suggestion-land",
    title: "重新认识脚下的土地",
    description: "从城市生态、食物与建筑出发，重新发现日常环境里的隐秘联系。",
    curator: "桥下自然社",
    itemCount: 21,
    tone: "sun",
    tags: ["城市", "自然", "人文"],
    reason: "保留你熟悉的「人文」，再向「城市生态」跨出一步",
    distance: "step",
    sampleTitles: [
      "一棵行道树的一百年",
      "菜市场如何讲述一座城",
      "被重新打开的河流",
    ],
  },
  {
    id: "suggestion-craft",
    title: "做东西的人",
    description: "十二位手艺人与创作者，谈那些无法加速的工作。",
    curator: "慢工通讯",
    itemCount: 12,
    tone: "clay",
    tags: ["手艺", "创作", "生活"],
    reason: "一次不参考兴趣权重的随机漫游",
    distance: "random",
    sampleTitles: [
      "修琴师如何听见木头",
      "一把椅子为什么要做三个月",
      "给一封信留出抵达的时间",
    ],
  },
  {
    id: "suggestion-questions",
    title: "问题比答案更长久",
    description: "关于教育、科学与判断力的一份小型阅读路径。",
    curator: "未完成编辑部",
    itemCount: 18,
    tone: "plum",
    tags: ["教育", "科学", "思考"],
    reason: "与你最近收藏的「提问」主题相近",
    distance: "near",
    sampleTitles: [
      "如何承认我们并不知道",
      "一堂没有标准答案的课",
      "证据、直觉和暂时的结论",
    ],
  },
];

export const defaultAppData: AppData = {
  version: 2,
  sources: seedSources,
  items: seedItems,
  collections: seedCollections,
  platformSessions: [],
  settings: {
    localMatching: true,
    includeCollectionUpdates: true,
    hiddenSuggestionIds: [],
    welcomeDismissed: false,
  },
};

export const contentTypeLabels: Record<ContentType, string> = {
  video: "视频",
  podcast: "播客",
  article: "文章",
};

export const platformLabels: Record<Platform, string> = {
  bilibili: "B 站",
  wechat: "微信公众号",
  zhihu: "知乎",
  xiaohongshu: "小红书",
  douyin: "抖音",
  kuaishou: "快手",
  weibo: "微博",
  xiaoyuzhou: "小宇宙",
  toutiao: "今日头条",
  baijiahao: "百家号",
  douban: "豆瓣",
  ximalaya: "喜马拉雅",
  rss: "RSS",
  podcast: "播客",
  web: "网页",
};
