import { DataManager } from "./data-manager.js";
import { CompendiumSelectorApp, CustomFilterFieldsApp, CategoryConfigApp, TagGroupConfigApp } from "./settings-apps.js";
import { FilterManager } from "./filter-manager.js";
import { ImageScanner, openImagePathsDialog } from "./image-scanner.js";
import { ASSET_LIBRARIAN_BASE_TABS, helpers } from "./helpers.js";
import {
    ASSET_LIBRARIAN_FLAG_SCOPE,
    ASSET_LIBRARIAN_TAG_REGISTRY_SETTING,
    getOrderedTagGroupsForDocType,
    normalizeTag,
    normalizeTagList,
    supportsFlagTagsForTab,
    tagToken,
} from "./asset-tags.js";
import {
    GET_ACTOR_CHARACTER_ART,
    GET_ACTOR_TOKEN_ART,
    GET_CARDS_DEAL_DIALOG,
    GET_CARDS_DRAW_DIALOG,
    GET_CARDS_PASS_DIALOG,
    GET_CARDS_SHUFFLE,
    GET_CONFIGURE_OWNERSHIP,
    GET_EXECUTE_MACRO,
    GET_IMPORT_TO_WORLD,
    GET_ITEM_VIEW_ART,
    GET_JUMP_TO_PIN,
    GET_PLAYLIST_BULK_IMPORT,
    GET_ROLLTABLE_DRAW_RESULT,
    GET_SEND_TO_PLAYER,
} from "./context.js";

const DragDrop = foundry.applications.ux.DragDrop.implementation;
const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const TAG_CATEGORY_GROUP_PREFIX = "tag:";
const THUMBNAIL_DIMENSIONS = 192;
const THUMBNAIL_QUALITY = 0.6;
const SCENE_PREVIEW_MAX_DIMENSION = 800;
const SCENE_PREVIEW_QUALITY = 0.8;
const THUMBNAIL_MEMORY_CACHE_LIMIT = 1000;
const THUMBNAIL_CONCURRENCY = 2;
const THUMBNAIL_BATCH_SIZE = 4;
const THUMBNAIL_PLACEHOLDER = "icons/svg/mystery-man.svg";
const THUMBNAIL_CACHE_MAP_SETTING = "thumbnailCacheMap";
const SCENE_PREVIEW_CACHE_MAP_SETTING = "scenePreviewCacheMap";
const DEFAULT_OPEN_VIEW_SETTING_KEY = "defaultOpenView";
const LAST_OPEN_VIEW_SETTING_KEY = "lastOpenView";
const FILTER_GROUP_OPEN_STATE_FLAG_KEY = "filterGroupOpenState";
const FILTER_GROUP_ORDER_FLAG_KEY = "filterGroupOrderByTab";
const DEFAULT_TAB_LEGACY_SETTING_KEY = "defaultTab";

export class AssetLibrarian extends HandlebarsApplicationMixin(ApplicationV2) {
    static BATCHING = {
        SIZE: 100,
        MARGIN: 200,
    };

    constructor(options = {}) {
        super(options);
        this.activeTab = "Actor";
        this.mode = "world";
        this.searchQuery = "";
        this.folderSearchQuery = "";
        this.activeFolderId = null;
        this.showDuplicates = false;
        this.bulkSelectMode = false;
        this.selectedAssetUuids = new Set();
        this.allAssets = [];
        this.filteredAssets = [];
        this.renderedAssets = [];
        this.folderTree = [];
        this.filters = [];
        this.isScanning = false;
        this.viewMode = game.settings.get("asset-librarian", "viewMode") || "large";
        this.activeCategoryGroup = "All";
        this._dataCache = new Map();
        this._filterOptionsCache = new Map();
        this._batchIndex = AssetLibrarian.BATCHING.SIZE;
        this._folderVisibilityCache = new Map();
        this._batchScrollRaf = null;
        this._batchFillRaf = null;
        this._batchResizeObserver = null;
        this._batchThrottle = false;
        this._preserveScrollTop = null;
        this._searchInputState = null;
        this._folderSearchInputState = null;
        this._dataVersion = 0;
        this._lastComputedFilterStateKey = null;
        this._mainRenderTimeout = null;
        this._hasShownNoTabsWarning = false;
        this._filterGroupOpenState = this._loadPersistedFilterGroupOpenState();
        this._filterGroupOpenStatePersistTimeout = null;
        this._filterGroupOrderByTab = this._loadPersistedFilterGroupOrderByTab();
        this._filterGroupOrderPersistTimeout = null;
        this._draggedFilterGroupEl = null;
        this._isPersistingFilterGroupOrder = false;
        this._tagRegistrySyncKeys = new Set();
        this._folderNodeOpenState = new Map();
        this._thumbnailCache = new Map();
        this._thumbnailKeysByTab = new Map();
        this._thumbnailJobTokens = new Map();
        this._thumbnailHydrationTimeout = null;
        this._thumbnailIdleCallbackId = null;
        this.#dragDrop = this.#createDragDropHandlers();
        this._imageLoadToken = 0;
        this._pendingOpenFilterRequest = null;
        this._thumbnailDiskMap = null;
        this._thumbnailMapFlushTimeout = null;
        this._thumbnailPersistPromises = new Map();
        this._scenePreviewDiskMap = null;
        this._scenePreviewMapFlushTimeout = null;
        this._scenePreviewPersistPromises = new Map();
        this._thumbnailBuildActive = false;
        this._thumbnailBuildDone = 0;
        this._thumbnailBuildTotal = 0;
        this._thumbnailBuildUiRaf = null;
        this._lazyLoadObserver = null;
        this._visibleImageUuids = new Set();
        this._scenePreviewCache = new Map();
        this._scenePreviewPromises = new Map();
    }

    _getDataCacheKey(mode = this.mode, tab = this.activeTab) {
        return `${mode}:${tab}`;
    }

    _isTabEnabled(type) {
        if (type === "Image") return game.user.isGM && ImageScanner.isEnabled();
        return game.settings.get("asset-librarian", `showTab${type}`) !== false;
    }

    _canonicalizeTabName(rawTab) {
        const requestedTab = typeof rawTab === "string" ? rawTab.trim() : "";
        if (!requestedTab) return "";
        const aliases = {
            actor: "Actor",
            actors: "Actor",
            item: "Item",
            items: "Item",
            journal: "JournalEntry",
            journals: "JournalEntry",
            journalentry: "JournalEntry",
            journalentries: "JournalEntry",
            scene: "Scene",
            scenes: "Scene",
            rolltable: "RollTable",
            rolltables: "RollTable",
            playlist: "Playlist",
            playlists: "Playlist",
            macro: "Macro",
            macros: "Macro",
            cards: "Cards",
            card: "Cards",
            adventure: "Adventure",
            adventures: "Adventure",
            image: "Image",
            images: "Image",
        };
        return aliases[requestedTab.toLowerCase()] || requestedTab;
    }

    _normalizeOpenFilterRequest(options) {
        if (!options || typeof options !== "object") return null;
        const rawTags = options.tagFilters ?? options.tags;
        const rawFilters = options.filters;
        if ((rawTags === null || rawTags === undefined) && (!Array.isArray(rawFilters) || !rawFilters.length)) return null;

        const defaultState = ["include", "and", "exclude"].includes(options.tagFilterState) ? options.tagFilterState : "include";
        const clearExisting = options.clearExistingFilters !== false;
        const tagRows = [];
        const filterRows = [];

        if (typeof rawTags === "string") {
            for (const value of normalizeTagList(rawTags)) tagRows.push({ value, state: defaultState });
        } else if (Array.isArray(rawTags)) {
            for (const entry of rawTags) {
                if (typeof entry === "string") {
                    const value = normalizeTag(entry);
                    if (value) tagRows.push({ value, state: defaultState });
                    continue;
                }
                if (!entry || typeof entry !== "object") continue;
                const value = normalizeTag(entry.value ?? entry.tag ?? entry.label ?? "");
                if (!value) continue;
                const state = ["include", "and", "exclude"].includes(entry.state) ? entry.state : defaultState;
                tagRows.push({ value, state });
            }
        } else if (typeof rawTags === "object") {
            for (const [rawValue, rawState] of Object.entries(rawTags)) {
                const value = normalizeTag(rawValue);
                if (!value) continue;
                const state = ["include", "and", "exclude"].includes(rawState) ? rawState : defaultState;
                tagRows.push({ value, state });
            }
        }

        if (Array.isArray(rawFilters)) {
            for (const entry of rawFilters) {
                if (!entry || typeof entry !== "object") continue;
                const key = String(entry.key ?? entry.filterKey ?? "").trim();
                const value = normalizeTag(entry.value ?? entry.filterValue ?? "");
                if (!key || !value) continue;
                const state = ["include", "and", "exclude"].includes(entry.state) ? entry.state : defaultState;
                filterRows.push({ key, value, state });
            }
        }

        const byToken = new Map();
        for (const row of tagRows) {
            const token = tagToken(row.value);
            if (!token) continue;
            byToken.set(token, row);
        }
        const byKeyValue = new Map();
        for (const row of filterRows) {
            const keyToken = `${row.key}::${tagToken(row.value)}`;
            byKeyValue.set(keyToken, row);
        }

        return {
            clearExisting,
            tagEntries: Array.from(byToken.values()),
            filterEntries: Array.from(byKeyValue.values()),
        };
    }

    _applyPendingOpenFilterRequest() {
        const request = this._pendingOpenFilterRequest;
        if (!request) return false;
        this._pendingOpenFilterRequest = null;

        if (request.clearExisting) {
            for (const group of this.filters) {
                for (const value of group.values) value.state = "off";
            }
        }

        let matched = false;
        if (Array.isArray(request.tagEntries) && request.tagEntries.length) {
            const filterTagGroup = this.filters.find((f) => f.key === "filterTag");
            if (filterTagGroup) {
                for (const row of request.tagEntries) {
                    const option = filterTagGroup.values.find((v) => tagToken(v.value) === tagToken(row.value));
                    if (!option) continue;
                    option.state = row.state;
                    matched = true;
                }
            }
        }
        if (Array.isArray(request.filterEntries) && request.filterEntries.length) {
            for (const row of request.filterEntries) {
                const group = this.filters.find((f) => f.key === row.key);
                if (!group) continue;
                const option = group.values.find((v) => tagToken(v.value) === tagToken(row.value));
                if (!option) continue;
                option.state = row.state;
                matched = true;
            }
        }
        return matched || request.clearExisting;
    }

    _getDefaultOpenPreference() {
        const raw = String(game.settings.get("asset-librarian", DEFAULT_OPEN_VIEW_SETTING_KEY) || "").trim();
        if (raw) {
            const [rawMode, rawTab] = raw.split(":", 2);
            const mode = rawMode === "compendium" ? "compendium" : "world";
            const tab = this._canonicalizeTabName(rawTab || "");
            if (tab) return { mode, tab };
        }

        const legacyTab = this._canonicalizeTabName(game.settings.get("asset-librarian", DEFAULT_TAB_LEGACY_SETTING_KEY) || "");
        if (legacyTab) return { mode: "world", tab: legacyTab };

        const legacyWorld = this._canonicalizeTabName(game.settings.get("asset-librarian", "defaultTabWorld") || "");
        if (legacyWorld) return { mode: "world", tab: legacyWorld };

        const legacyCompendium = this._canonicalizeTabName(game.settings.get("asset-librarian", "defaultTabCompendium") || "");
        if (legacyCompendium) return { mode: "compendium", tab: legacyCompendium };

        return null;
    }

    _getLastOpenPreference() {
        const raw = String(game.settings.get("asset-librarian", LAST_OPEN_VIEW_SETTING_KEY) || "").trim();
        if (!raw) return null;
        const [rawMode, rawTab] = raw.split(":", 2);
        const mode = rawMode === "compendium" ? "compendium" : "world";
        const tab = this._canonicalizeTabName(rawTab || "");
        if (!tab) return null;
        return { mode, tab };
    }

    _setLastOpenPreference(mode, tab) {
        const normalizedMode = mode === "compendium" ? "compendium" : "world";
        const canonicalTab = this._canonicalizeTabName(tab);
        if (!canonicalTab) return;
        const next = `${normalizedMode}:${canonicalTab}`;
        const current = String(game.settings.get("asset-librarian", LAST_OPEN_VIEW_SETTING_KEY) || "");
        if (current === next) return;
        void game.settings.set("asset-librarian", LAST_OPEN_VIEW_SETTING_KEY, next);
    }

    _getEnabledTabs(mode = this.mode) {
        const tabs = [...ASSET_LIBRARIAN_BASE_TABS, ...(ImageScanner.isEnabled() ? ["Image"] : [])].filter((type) =>
            this._isTabEnabled(type),
        );
        if (mode === "world") {
            return tabs.filter((type) => type !== "Adventure");
        }
        return tabs;
    }

    _getWindowTitle() {
        const key =
            this.mode === "compendium"
                ? "ASSET_LIBRARIAN.WindowTitle.CompendiumView"
                : "ASSET_LIBRARIAN.WindowTitle.WorldView";
        return game.i18n.localize(key);
    }

    _shouldGenerateThumbnailsForTab(tab = this.activeTab) {
        return tab === "Image" || tab === "Adventure";
    }

    _getThumbnailCacheKey(src) {
        return `${src}|w=${THUMBNAIL_DIMENSIONS}|h=${THUMBNAIL_DIMENSIONS}|q=${THUMBNAIL_QUALITY}`;
    }

    _hashString(value) {
        let hash = 2166136261;
        const input = String(value ?? "");
        for (let i = 0; i < input.length; i++) {
            hash ^= input.charCodeAt(i);
            hash = Math.imul(hash, 16777619);
        }
        return (hash >>> 0).toString(16).padStart(8, "0");
    }

    _getThumbnailCacheDirectory() {
        return `worlds/${game.world.id}/assets/asset-librarian/thumbs`;
    }

    _getScenePreviewCacheDirectory() {
        return `worlds/${game.world.id}/assets/asset-librarian/scene-thumbnails`;
    }

    _useDiskThumbnailCache() {
        return game.settings.get("asset-librarian", "useDiskThumbnailCache") === true;
    }

    _useDiskScenePreviewCache() {
        return game.settings.get("asset-librarian", "useDiskScenePreviewCache") === true;
    }

    _getThumbnailDiskMap() {
        if (!this._useDiskThumbnailCache()) return {};
        if (!this._thumbnailDiskMap) {
            const stored = game.settings.get("asset-librarian", THUMBNAIL_CACHE_MAP_SETTING) || {};
            this._thumbnailDiskMap = { ...(stored && typeof stored === "object" ? stored : {}) };
        }
        return this._thumbnailDiskMap;
    }

    _getScenePreviewDiskMap() {
        if (!this._useDiskScenePreviewCache()) return {};
        if (!this._scenePreviewDiskMap) {
            const stored = game.settings.get("asset-librarian", SCENE_PREVIEW_CACHE_MAP_SETTING) || {};
            this._scenePreviewDiskMap = { ...(stored && typeof stored === "object" ? stored : {}) };
        }
        return this._scenePreviewDiskMap;
    }

    _scheduleThumbnailMapFlush() {
        if (!this._useDiskThumbnailCache()) return;
        if (!game.user.isGM) return;
        clearTimeout(this._thumbnailMapFlushTimeout);
        this._thumbnailMapFlushTimeout = setTimeout(() => {
            const payload = { ...(this._thumbnailDiskMap || {}) };
            void game.settings.set("asset-librarian", THUMBNAIL_CACHE_MAP_SETTING, payload);
        }, 400);
    }

    _scheduleScenePreviewMapFlush() {
        if (!this._useDiskScenePreviewCache()) return;
        if (!game.user.isGM) return;
        clearTimeout(this._scenePreviewMapFlushTimeout);
        this._scenePreviewMapFlushTimeout = setTimeout(() => {
            const payload = { ...(this._scenePreviewDiskMap || {}) };
            void game.settings.set("asset-librarian", SCENE_PREVIEW_CACHE_MAP_SETTING, payload);
        }, 400);
    }

    _getThumbnailDiskPath(cacheKey) {
        const filename = `${this._hashString(cacheKey)}.webp`;
        return `${this._getThumbnailCacheDirectory()}/${filename}`;
    }

    _getScenePreviewDiskPath(cacheKey) {
        const filename = `${this._hashString(cacheKey)}.webp`;
        return `${this._getScenePreviewCacheDirectory()}/${filename}`;
    }

    _normalizeFilePickerPath(path) {
        const raw = String(path || "").trim();
        if (!raw) return "";
        let normalized = raw;
        if (/^https?:\/\//i.test(normalized)) {
            try {
                const url = new URL(normalized);
                normalized = `${url.pathname || ""}${url.search || ""}`;
            } catch (_err) {
                // Keep original if URL parsing fails.
            }
        }
        const queryIndex = normalized.indexOf("?");
        if (queryIndex >= 0) normalized = normalized.slice(0, queryIndex);
        normalized = normalized.replace(/^\/+/, "");
        return normalized;
    }

    async _ensureThumbnailDirectory(source, dir = this._getThumbnailCacheDirectory()) {
        const fp = foundry.applications.apps.FilePicker.implementation;
        try {
            await fp.browse(source, dir);
            return true;
        } catch (_err) {
            const parts = dir.split("/").filter(Boolean);
            let current = "";
            for (const part of parts) {
                current = current ? `${current}/${part}` : part;
                try {
                    await fp.browse(source, current);
                } catch {
                    try {
                        await fp.createDirectory(source, current);
                    } catch (_createErr) {
                        return false;
                    }
                }
            }
            return true;
        }
    }

    async _persistThumbnailToDisk(cacheKey, thumbDataUrl) {
        if (!this._useDiskThumbnailCache()) return null;
        if (!game.user.isGM || !cacheKey || !thumbDataUrl) return null;
        const map = this._getThumbnailDiskMap();
        if (map[cacheKey]) return map[cacheKey];
        if (this._thumbnailPersistPromises.has(cacheKey)) return this._thumbnailPersistPromises.get(cacheKey);

        const promise = (async () => {
            const fp = foundry.applications.apps.FilePicker.implementation;
            const path = this._getThumbnailDiskPath(cacheKey);
            const filename = path.split("/").pop();
            const directory = path.slice(0, path.length - filename.length - 1);
            const blob = await fetch(thumbDataUrl).then((r) => r.blob());
            const file = new File([blob], filename, { type: "image/webp" });
            const sources = typeof ImageScanner.getFilePickerSources === "function" ? ImageScanner.getFilePickerSources() : ["data"];

            for (const source of sources) {
                const ok = await this._ensureThumbnailDirectory(source, directory);
                if (!ok) continue;
                try {
                    const response = await fp.upload(source, directory, file, {}, { notify: false });
                    const storedPath = response?.path || path;
                    map[cacheKey] = storedPath;
                    this._scheduleThumbnailMapFlush();
                    return storedPath;
                } catch (_err) {
                    // Try next available source.
                }
            }
            return null;
        })()
            .finally(() => {
                this._thumbnailPersistPromises.delete(cacheKey);
            });

        this._thumbnailPersistPromises.set(cacheKey, promise);
        return promise;
    }

    async _persistScenePreviewToDisk(cacheKey, thumbDataUrl) {
        if (!this._useDiskScenePreviewCache()) return null;
        if (!game.user.isGM || !cacheKey || !thumbDataUrl) return null;
        const map = this._getScenePreviewDiskMap();
        if (map[cacheKey]) return map[cacheKey];
        if (this._scenePreviewPersistPromises.has(cacheKey)) return this._scenePreviewPersistPromises.get(cacheKey);

        const promise = (async () => {
            const fp = foundry.applications.apps.FilePicker.implementation;
            const path = this._getScenePreviewDiskPath(cacheKey);
            const filename = path.split("/").pop();
            const directory = path.slice(0, path.length - filename.length - 1);
            const blob = await fetch(thumbDataUrl).then((r) => r.blob());
            const file = new File([blob], filename, { type: "image/webp" });
            const sources = typeof ImageScanner.getFilePickerSources === "function" ? ImageScanner.getFilePickerSources() : ["data"];

            for (const source of sources) {
                const ok = await this._ensureThumbnailDirectory(source, directory);
                if (!ok) continue;
                try {
                    const response = await fp.upload(source, directory, file, {}, { notify: false });
                    const storedPath = response?.path || path;
                    map[cacheKey] = storedPath;
                    this._scheduleScenePreviewMapFlush();
                    return storedPath;
                } catch (_err) {
                    // Try next available source.
                }
            }
            return null;
        })()
            .finally(() => {
                this._scenePreviewPersistPromises.delete(cacheKey);
            });

        this._scenePreviewPersistPromises.set(cacheKey, promise);
        return promise;
    }

    async _deleteFilePickerPath(path, { recursive = false, source = null } = {}) {
        if (!path) return false;
        const rawPath = String(path || "").trim();
        const normalizedPath = this._normalizeFilePickerPath(path);
        const pathCandidates = Array.from(new Set([rawPath, normalizedPath].filter(Boolean)));
        if (!pathCandidates.length) return false;
        const sources = source
            ? [source]
            : typeof ImageScanner.getFilePickerSources === "function"
                ? ImageScanner.getFilePickerSources()
                : ["data"];
        for (const source of sources) {
            for (const candidatePath of pathCandidates) {
                const isDirectoryLike =
                    recursive || candidatePath.endsWith("/") || !candidatePath.includes(".");
                const existedBefore = await this._pathExistsInSource(source, candidatePath, { directory: isDirectoryLike });
                if (!existedBefore) return true;
                const actionOrder = isDirectoryLike
                    ? ["deleteDirectory", "deleteFolder", "deleteFile", "deleteFiles", "delete"]
                    : ["deleteFile", "deleteFiles", "deleteDirectory", "deleteFolder", "delete"];
                for (const action of actionOrder) {
                    const result = await this._manageFilesAction(action, source, candidatePath, { recursive });
                    if (result === null) continue;
                    const stillExists = await this._pathExistsInSource(source, candidatePath, { directory: isDirectoryLike });
                    if (!stillExists) return true;
                }
            }
        }
        return false;
    }

    async _manageFilesAction(action, source, target, options = {}) {
        if (!action || !source || !target) return null;
        return new Promise((resolve) => {
            try {
                game.socket.emit("manageFiles", { action, storage: source, target }, options, (result) => {
                    if (result?.error) return resolve(null);
                    return resolve(result ?? {});
                });
            } catch (_err) {
                return resolve(null);
            }
        });
    }

    _splitPath(path) {
        const normalized = this._normalizeFilePickerPath(path);
        if (!normalized) return { directory: "", name: "" };
        const parts = normalized.split("/").filter(Boolean);
        const name = parts.pop() || "";
        return { directory: parts.join("/"), name };
    }

    async _pathExistsInSource(source, path, { directory = false } = {}) {
        const normalized = this._normalizeFilePickerPath(path);
        if (!normalized) return false;
        if (directory || normalized.endsWith("/") || !normalized.includes(".")) {
            const listing = await this._browseFilePickerPath(source, normalized.replace(/\/+$/, ""));
            return !!listing;
        }

        const { directory: parentDir, name } = this._splitPath(normalized);
        const listing = await this._browseFilePickerPath(source, parentDir);
        const files = Array.isArray(listing?.files) ? listing.files : [];
        const normalizedTarget = this._normalizeFilePickerPath(normalized);
        const normalizedByName = this._normalizeFilePickerPath(`${parentDir ? `${parentDir}/` : ""}${name}`);
        for (const filePath of files) {
            const normalizedFile = this._normalizeFilePickerPath(filePath);
            if (!normalizedFile) continue;
            if (normalizedFile === normalizedTarget || normalizedFile === normalizedByName) return true;
        }
        return false;
    }

    async _browseFilePickerPath(source, path) {
        const fp = foundry.applications.apps.FilePicker.implementation;
        if (!fp || typeof fp.browse !== "function") return null;
        const normalizedPath = this._normalizeFilePickerPath(path);
        if (!normalizedPath) return null;
        const attempts = [() => fp.browse(source, normalizedPath), () => fp.browse(normalizedPath)];
        for (const attempt of attempts) {
            try {
                const result = await attempt();
                if (result) return result;
            } catch (_err) {
                // Try next signature.
            }
        }
        return null;
    }

    async _deleteCacheDirectoryAndKnownFiles(directory, knownPaths = []) {
        const normalizedDirectory = this._normalizeFilePickerPath(directory);
        if (!normalizedDirectory) return 0;
        const sources = normalizedDirectory.startsWith("worlds/")
            ? ["data"]
            : typeof ImageScanner.getFilePickerSources === "function"
                ? ImageScanner.getFilePickerSources()
                : ["data"];
        const targetsBySource = new Map();
        for (const source of sources) {
            targetsBySource.set(source, new Set());
        }
        const knownCandidates = Array.from(
            new Set(
                (Array.isArray(knownPaths) ? knownPaths : [])
                    .map((p) => String(p || "").trim())
                    .filter(Boolean),
            ),
        );

        for (const source of sources) {
            const sourceTargets = targetsBySource.get(source);
            for (const p of knownCandidates) sourceTargets.add(p);
            const listing = await this._browseFilePickerPath(source, normalizedDirectory);
            const files = Array.isArray(listing?.files) ? listing.files : [];
            for (const filePath of files) {
                const rawFile = String(filePath || "").trim();
                if (rawFile) sourceTargets.add(rawFile);
            }
            const dirs = Array.isArray(listing?.dirs) ? listing.dirs : [];
            for (const dirPath of dirs) {
                const rawDir = String(dirPath || "").trim();
                if (rawDir) sourceTargets.add(rawDir);
            }
        }

        let removedFiles = 0;
        for (const source of sources) {
            const sourceTargets = Array.from(targetsBySource.get(source) || []);
            for (const target of sourceTargets) {
                const isDirectoryLike = target.endsWith("/") || target === normalizedDirectory || !target.includes(".");
                const removed = await this._deleteFilePickerPath(target, {
                    recursive: isDirectoryLike,
                    source,
                });
                if (removed && !isDirectoryLike) removedFiles += 1;
            }
            await this._deleteFilePickerPath(normalizedDirectory, { recursive: true, source });
        }
        return removedFiles;
    }

    _dropBrokenPathFromMap(map, brokenPath) {
        const normalizedBrokenPath = this._normalizeFilePickerPath(brokenPath);
        if (!normalizedBrokenPath || !map || typeof map !== "object") return [];
        const removedKeys = [];
        for (const [cacheKey, storedPath] of Object.entries(map)) {
            if (this._normalizeFilePickerPath(storedPath) !== normalizedBrokenPath) continue;
            delete map[cacheKey];
            removedKeys.push(cacheKey);
        }
        return removedKeys;
    }

    _evictBrokenCachedPath(path) {
        const normalizedPath = this._normalizeFilePickerPath(path);
        if (!normalizedPath) return { thumbnailKeys: [], scenePreviewKeys: [] };
        const thumbnailMap = this._getThumbnailDiskMap();
        const thumbnailKeys = this._dropBrokenPathFromMap(thumbnailMap, normalizedPath);
        if (thumbnailKeys.length) {
            for (const key of thumbnailKeys) this._thumbnailCache.delete(key);
            this._scheduleThumbnailMapFlush();
        }

        const scenePreviewMap = this._getScenePreviewDiskMap();
        const scenePreviewKeys = this._dropBrokenPathFromMap(scenePreviewMap, normalizedPath);
        if (scenePreviewKeys.length) {
            for (const key of scenePreviewKeys) this._scenePreviewCache.delete(key);
            this._scheduleScenePreviewMapFlush();
        }

        return { thumbnailKeys, scenePreviewKeys };
    }

    async _isImagePathAvailable(path) {
        const candidate = String(path || "").trim();
        if (!candidate) return false;
        if (candidate.startsWith("data:")) return true;
        try {
            const probePath = candidate.includes("?")
                ? `${candidate}&_al_probe=${Date.now()}`
                : `${candidate}?_al_probe=${Date.now()}`;
            const response = await fetch(probePath, {
                method: "GET",
                cache: "no-store",
            });
            return response.ok;
        } catch (_err) {
            return false;
        }
    }

    async _onAssetImageLoadError(img) {
        if (!img) return;
        const current = String(img.currentSrc || img.src || img.dataset?.src || "").trim();
        if (!current || current === THUMBNAIL_PLACEHOLDER) return;
        this._evictBrokenCachedPath(current);
        img.removeAttribute("data-src");
        img.src = THUMBNAIL_PLACEHOLDER;

        const card = img.closest?.(".asset-card[data-uuid]");
        const uuid = card?.dataset?.uuid;
        if (!uuid) return;
        const asset = this.allAssets.find((entry) => entry?.uuid === uuid);
        if (!asset?.img) return;

        const cacheKey = this._getThumbnailCacheKey(asset.img);
        this._thumbnailCache.delete(cacheKey);
        const map = this._getThumbnailDiskMap();
        if (map[cacheKey]) {
            delete map[cacheKey];
            this._scheduleThumbnailMapFlush();
        }
        delete asset._thumb;

        if (this._shouldGenerateThumbnailsForTab(this.activeTab)) {
            void this._startThumbnailHydration([asset], this.activeTab, this.mode, { prune: false });
        }
    }

    async clearThumbnailCache({ clearDisk = true } = {}) {
        if (!game.user.isGM) {
            ui.notifications.warn(game.i18n.localize("ASSET_LIBRARIAN.Tagging.NoPermission"));
            return { removedEntries: 0, removedFiles: 0, requestedFiles: 0, diskDeleteAttempted: false };
        }
        const map = this._getThumbnailDiskMap();
        const knownPaths = Array.from(
            new Set(
                Object.values(map)
                    .map((p) => String(p || "").trim())
                    .filter(Boolean),
            ),
        );
        const requestedFiles = knownPaths.length;
        let removedFiles = 0;
        let diskDeleteAttempted = false;
        if (clearDisk) {
            diskDeleteAttempted = true;
            removedFiles = await this._deleteCacheDirectoryAndKnownFiles(this._getThumbnailCacheDirectory(), knownPaths);
        }

        const removedEntries = Object.keys(map).length;
        this._thumbnailCache.clear();
        this._thumbnailKeysByTab.clear();
        this._thumbnailDiskMap = {};
        this._thumbnailPersistPromises.clear();
        this._thumbnailJobTokens.delete(`${this.mode}:Image`);
        await game.settings.set("asset-librarian", THUMBNAIL_CACHE_MAP_SETTING, {});

        if (this.activeTab === "Image") {
            this._lastComputedFilterStateKey = null;
            this._applyFilters();
            this.render();
        }
        return { removedEntries, removedFiles, requestedFiles, diskDeleteAttempted };
    }

    async clearScenePreviewCache({ clearDisk = true } = {}) {
        if (!game.user.isGM) {
            ui.notifications.warn(game.i18n.localize("ASSET_LIBRARIAN.Tagging.NoPermission"));
            return { removedEntries: 0, removedFiles: 0, requestedFiles: 0, diskDeleteAttempted: false };
        }
        const map = this._getScenePreviewDiskMap();
        const knownPaths = Array.from(
            new Set(
                Object.values(map)
                    .map((p) => String(p || "").trim())
                    .filter(Boolean),
            ),
        );
        const requestedFiles = knownPaths.length;
        let removedFiles = 0;
        let diskDeleteAttempted = false;
        if (clearDisk) {
            diskDeleteAttempted = true;
            removedFiles = await this._deleteCacheDirectoryAndKnownFiles(this._getScenePreviewCacheDirectory(), knownPaths);
        }

        const removedEntries = Object.keys(map).length;
        this._scenePreviewCache.clear();
        this._scenePreviewPromises.clear();
        this._scenePreviewDiskMap = {};
        this._scenePreviewPersistPromises.clear();
        await game.settings.set("asset-librarian", SCENE_PREVIEW_CACHE_MAP_SETTING, {});
        return { removedEntries, removedFiles, requestedFiles, diskDeleteAttempted };
    }

    async buildImageThumbnailCache({ forceRescan = true, quiet = true } = {}) {
        if (!game.user.isGM) {
            ui.notifications.warn(game.i18n.localize("ASSET_LIBRARIAN.Tagging.NoPermission"));
            return false;
        }
        this.isScanning = true;
        if (this.activeTab === "Image") this.render();

        if (forceRescan) ImageScanner.invalidateImageCache();
        const images = await ImageScanner.startBackgroundScan({ force: forceRescan });
        const nextAssets = Array.isArray(images) ? images : [];
        this._pruneThumbnailManifestForCurrentImages(nextAssets, { force: true });
        this._thumbnailJobTokens.delete(`${this.mode}:Image`);

        if (this.activeTab === "Image") {
            this.allAssets = nextAssets;
            this.folderTree = ImageScanner.buildFolderTree(nextAssets);
            this._dataCache.set(this._getDataCacheKey(this.mode, "Image"), {
                assets: nextAssets,
                folderTree: this.folderTree,
            });
            this._lastComputedFilterStateKey = null;
            this._applyFilters();
            this.render();
        }

        this.isScanning = false;
        const summary = await this._startThumbnailHydration([...nextAssets], "Image", this.mode, { prune: true });
        if (!quiet) return true;
        if (!summary || summary.cancelled) {
            ui.notifications.info("Asset Librarian | Thumbnail cache build cancelled.");
            return true;
        }
        const reused = Number(summary.memoryHits || 0) + Number(summary.diskHits || 0);
        ui.notifications.info(
            `Asset Librarian | Thumbnail build complete. Built ${summary.built}/${summary.total}, reused ${reused}, failed ${summary.failed} (${summary.ms}ms).`,
        );
        return true;
    }

    _setThumbnailBuildProgress(active, done = 0, total = 0) {
        this._thumbnailBuildActive = active;
        this._thumbnailBuildDone = done;
        this._thumbnailBuildTotal = total;
        this._scheduleThumbnailBuildStatusDOM();
    }

    _getThumbnailMemoryCacheLimit() {
        return THUMBNAIL_MEMORY_CACHE_LIMIT;
    }

    _pruneThumbnailMemoryCache() {
        const limit = this._getThumbnailMemoryCacheLimit();
        if (limit === 0) return;
        while (this._thumbnailCache.size > limit) {
            const oldest = this._thumbnailCache.keys().next().value;
            this._thumbnailCache.delete(oldest);
        }
    }

    _getThumbnailFromMemoryCache(cacheKey) {
        if (!cacheKey) return null;
        const value = this._thumbnailCache.get(cacheKey);
        if (!value) return null;
        this._thumbnailCache.delete(cacheKey);
        this._thumbnailCache.set(cacheKey, value);
        return value;
    }

    _setThumbnailInMemoryCache(cacheKey, value) {
        if (!cacheKey || !value) return;
        if (this._thumbnailCache.has(cacheKey)) this._thumbnailCache.delete(cacheKey);
        this._thumbnailCache.set(cacheKey, value);
        this._pruneThumbnailMemoryCache();
    }

    _scheduleThumbnailBuildStatusDOM() {
        if (!this.rendered) return;
        if (this._thumbnailBuildUiRaf) return;
        this._thumbnailBuildUiRaf = requestAnimationFrame(() => {
            this._thumbnailBuildUiRaf = null;
            this._updateThumbnailBuildStatusDOM();
        });
    }

    _updateThumbnailBuildStatusDOM() {
        if (!this.rendered) return;
        const el = this.element?.querySelector(".thumbnail-build-status");
        if (!el) return;
        const shouldShow =
            this._thumbnailBuildActive &&
            this._thumbnailBuildTotal > 0 &&
            this._shouldGenerateThumbnailsForTab(this.activeTab);
        el.classList.toggle("hidden", !shouldShow);
        if (shouldShow) {
            el.textContent = `Building thumbnails ${this._thumbnailBuildDone}/${this._thumbnailBuildTotal}`;
        }
    }

    _pruneThumbnailManifestForCurrentImages(images, { force = false } = {}) {
        if (!game.user.isGM) return { removedEntries: 0 };
        const scanMeta = ImageScanner.getLastScanMeta();
        const removedByDiff = Number(scanMeta?.counts?.removed || 0);
        if (!force && removedByDiff <= 0) return { removedEntries: 0 };

        const validKeys = new Set(
            (Array.isArray(images) ? images : [])
                .map((asset) => asset?.img)
                .filter(Boolean)
                .map((src) => this._getThumbnailCacheKey(src)),
        );
        const map = this._getThumbnailDiskMap();
        let removedEntries = 0;
        for (const cacheKey of Object.keys(map)) {
            if (validKeys.has(cacheKey)) continue;
            delete map[cacheKey];
            this._thumbnailCache.delete(cacheKey);
            removedEntries += 1;
        }
        if (removedEntries > 0) {
            this._scheduleThumbnailMapFlush();
            this._debugCache("Pruned thumbnail manifest entries", {
                removedEntries,
                diffRemoved: removedByDiff,
                totalImages: validKeys.size,
            });
        }
        return { removedEntries };
    }

    _getThumbnailSrc(src) {
        if (!src) return src;
        const cacheKey = this._getThumbnailCacheKey(src);
        return this._getThumbnailFromMemoryCache(cacheKey) || src;
    }

    _getAssetDisplayImage(asset) {
        if (!asset) return THUMBNAIL_PLACEHOLDER;
        if (!this._shouldGenerateThumbnailsForTab()) return asset._thumb || this._getThumbnailSrc(asset.img);
        const cacheKey = this._getThumbnailCacheKey(asset.img);
        const cachedThumb = this._getThumbnailFromMemoryCache(cacheKey);
        if (asset._thumb) return asset._thumb;
        if (cachedThumb) return cachedThumb;
        const diskThumb = this._getThumbnailDiskMap()?.[cacheKey];
        if (diskThumb) {
            this._setThumbnailInMemoryCache(cacheKey, diskThumb);
            return diskThumb;
        }
        return THUMBNAIL_PLACEHOLDER;
    }

    _syncThumbnailKeysForTab(tab, validKeys) {
        if (!this._shouldGenerateThumbnailsForTab(tab)) return;
        const nextKeys = new Set(validKeys);
        const previous = this._thumbnailKeysByTab.get(tab) || new Set();
        this._thumbnailKeysByTab.set(tab, nextKeys);

        for (const staleKey of previous) {
            if (nextKeys.has(staleKey)) continue;
            let usedElsewhere = false;
            for (const [otherTab, keys] of this._thumbnailKeysByTab.entries()) {
                if (otherTab === tab) continue;
                if (keys.has(staleKey)) {
                    usedElsewhere = true;
                    break;
                }
            }
            if (!usedElsewhere) this._thumbnailCache.delete(staleKey);
        }
    }

    _applyThumbnailToRenderedCard(uuid, thumb) {
        if (!this.rendered || !uuid || !thumb) return;
        const cards = this.element?.querySelectorAll?.(".asset-card[data-uuid]");
        let card = null;
        if (cards?.length) {
            for (const candidate of cards) {
                if (candidate?.dataset?.uuid === uuid) {
                    card = candidate;
                    break;
                }
            }
        }
        if (!card) return;
        const img = card.querySelector("img");
        if (!img) return;
        if (img.dataset?.src !== undefined) img.dataset.src = thumb;
        if (img.getAttribute("src") !== thumb) {
            img.src = thumb;
        }
    }

    _getHydrationPriorityMap() {
        const priorities = new Map();
        const cards = this.element?.querySelectorAll?.(".asset-card[data-uuid]");
        if (!cards?.length) return priorities;
        let index = 0;
        for (const card of cards) {
            const uuid = card?.dataset?.uuid;
            if (!uuid) continue;
            const priority = this._visibleImageUuids.has(uuid) ? 0 : 1;
            priorities.set(uuid, { priority, index });
            index += 1;
        }
        return priorities;
    }

    _startThumbnailHydration(assets, tab = this.activeTab, mode = this.mode, { prune = false, onComplete = null } = {}) {
        if (!this._shouldGenerateThumbnailsForTab(tab) || !Array.isArray(assets) || !assets.length) return Promise.resolve(null);

        let completeResolved = false;
        let resolveComplete;
        const completion = new Promise((resolve) => {
            resolveComplete = resolve;
        });
        const complete = (payload) => {
            if (completeResolved) return;
            completeResolved = true;
            if (typeof onComplete === "function") {
                try {
                    onComplete(payload);
                } catch (_err) {
                    // Ignore callback errors.
                }
            }
            resolveComplete(payload);
        };

        const jobKey = `${mode}:${tab}`;
        const token = `${Date.now()}:${Math.random()}`;
        this._thumbnailJobTokens.set(jobKey, token);
        const diskMap = this._getThumbnailDiskMap();
        const queue = [...assets];
        const priorityMap = this._getHydrationPriorityMap();
        queue.sort((a, b) => {
            const aInfo = priorityMap.get(a?.uuid) || { priority: 2, index: Number.MAX_SAFE_INTEGER };
            const bInfo = priorityMap.get(b?.uuid) || { priority: 2, index: Number.MAX_SAFE_INTEGER };
            if (aInfo.priority !== bInfo.priority) return aInfo.priority - bInfo.priority;
            return aInfo.index - bInfo.index;
        });
        const validKeys = prune
            ? new Set(
                  queue
                      .map((asset) => asset?.img)
                      .filter(Boolean)
                      .map((src) => this._getThumbnailCacheKey(src)),
              )
            : null;
        const metrics = {
            started: performance.now(),
            total: queue.length,
            memoryHits: 0,
            diskHits: 0,
            built: 0,
            failed: 0,
        };
        let pendingBuildCount = 0;
        for (const asset of queue) {
            const src = asset?.img;
            if (!src) continue;
            const cacheKey = this._getThumbnailCacheKey(src);
            if (this._thumbnailCache.has(cacheKey)) continue;
            if (diskMap[cacheKey]) continue;
            pendingBuildCount += 1;
        }
        if (pendingBuildCount > 0 && this.activeTab === tab && this.mode === mode) {
            this._setThumbnailBuildProgress(true, 0, pendingBuildCount);
        } else if (this.activeTab === tab && this.mode === mode && this._thumbnailBuildActive) {
            this._setThumbnailBuildProgress(false, 0, 0);
        }

        const processBatch = async () => {
            if (this._thumbnailJobTokens.get(jobKey) !== token) {
                complete({ cancelled: true, tab, mode });
                return;
            }

            const batch = [];
            while (queue.length && batch.length < THUMBNAIL_BATCH_SIZE) {
                const asset = queue.shift();
                if (!asset?.img) continue;
                const cacheKey = this._getThumbnailCacheKey(asset.img);
                const cachedThumb = this._getThumbnailFromMemoryCache(cacheKey);
                if (cachedThumb) {
                    metrics.memoryHits += 1;
                    asset._thumb = cachedThumb;
                    if (this.mode === mode && this.activeTab === tab) {
                        this._applyThumbnailToRenderedCard(asset.uuid, cachedThumb);
                    }
                    continue;
                }
                const diskThumb = diskMap[cacheKey];
                if (diskThumb) {
                    metrics.diskHits += 1;
                    this._setThumbnailInMemoryCache(cacheKey, diskThumb);
                    asset._thumb = diskThumb;
                    if (this.mode === mode && this.activeTab === tab) {
                        this._applyThumbnailToRenderedCard(asset.uuid, diskThumb);
                    }
                    continue;
                }
                batch.push({ asset, cacheKey, src: asset.img });
            }

            let cursor = 0;
            const workers = Array.from({ length: Math.min(THUMBNAIL_CONCURRENCY, batch.length) }, () =>
                (async () => {
                    while (cursor < batch.length) {
                        if (this._thumbnailJobTokens.get(jobKey) !== token) return;
                        const index = cursor++;
                        const entry = batch[index];
                        if (!entry) continue;
                        try {
                            const result = await foundry.helpers.media.ImageHelper.createThumbnail(entry.src, {
                                width: THUMBNAIL_DIMENSIONS,
                                height: THUMBNAIL_DIMENSIONS,
                                quality: THUMBNAIL_QUALITY,
                                format: "image/webp"
                            });
                            let thumb = result?.thumb || entry.src;
                            const diskThumb = await this._persistThumbnailToDisk(entry.cacheKey, thumb);
                            if (diskThumb) {
                                thumb = diskThumb;
                                diskMap[entry.cacheKey] = diskThumb;
                            }
                            this._setThumbnailInMemoryCache(entry.cacheKey, thumb);
                            metrics.built += 1;
                            entry.asset._thumb = thumb;
                            if (this.mode === mode && this.activeTab === tab) {
                                this._applyThumbnailToRenderedCard(entry.asset.uuid, thumb);
                            }
                            if (pendingBuildCount > 0) {
                                const nextDone = Math.min(this._thumbnailBuildDone + 1, this._thumbnailBuildTotal);
                                this._setThumbnailBuildProgress(true, nextDone, this._thumbnailBuildTotal);
                            }
                        } catch (_err) {
                            metrics.failed += 1;
                            entry.asset._thumb = THUMBNAIL_PLACEHOLDER;
                        }
                    }
                })(),
            );

            if (workers.length) await Promise.allSettled(workers);

            if (this._thumbnailJobTokens.get(jobKey) !== token) {
                complete({ cancelled: true, tab, mode });
                return;
            }
            if (queue.length) {
                setTimeout(() => {
                    processBatch().catch(() => {});
                }, 70);
                return;
            }

            if (prune && validKeys) this._syncThumbnailKeysForTab(tab, validKeys);
            this._pruneThumbnailMemoryCache();
            this._thumbnailJobTokens.delete(jobKey);
            if (pendingBuildCount > 0 && this.mode === mode && this.activeTab === tab) {
                this._setThumbnailBuildProgress(false, this._thumbnailBuildTotal, this._thumbnailBuildTotal);
            }
            this._debugCache("Thumbnail hydration finished", {
                tab,
                mode,
                total: metrics.total,
                memoryHits: metrics.memoryHits,
                diskHits: metrics.diskHits,
                built: metrics.built,
                failed: metrics.failed,
                ms: Math.round(performance.now() - metrics.started),
            });
            complete({
                cancelled: false,
                tab,
                mode,
                total: metrics.total,
                memoryHits: metrics.memoryHits,
                diskHits: metrics.diskHits,
                built: metrics.built,
                failed: metrics.failed,
                ms: Math.round(performance.now() - metrics.started),
            });
        };

        setTimeout(() => {
            processBatch().catch(() => {});
        }, 0);
        return completion;
    }

    _hasPendingRenderedThumbnails() {
        if (!this._shouldGenerateThumbnailsForTab() || !Array.isArray(this.renderedAssets) || !this.renderedAssets.length) return false;
        const diskMap = this._getThumbnailDiskMap();
        return this.renderedAssets.some((asset) => {
            const src = asset?.img;
            if (!src) return false;
            if (asset._thumb) return false;
            const cacheKey = this._getThumbnailCacheKey(src);
            if (this._thumbnailCache.has(cacheKey)) return false;
            return !diskMap?.[cacheKey];
        });
    }

    _scheduleRenderedThumbnailHydration() {
        if (!this._hasPendingRenderedThumbnails()) return;
        clearTimeout(this._thumbnailHydrationTimeout);
        this._thumbnailHydrationTimeout = setTimeout(() => {
            const run = () => {
                if (!this.rendered) return;
                if (!this._hasPendingRenderedThumbnails()) return;
                this._startThumbnailHydration([...this.renderedAssets], this.activeTab, this.mode, { prune: false });
            };
            if (typeof requestIdleCallback === "function") {
                if (this._thumbnailIdleCallbackId) cancelIdleCallback(this._thumbnailIdleCallbackId);
                this._thumbnailIdleCallbackId = requestIdleCallback(() => {
                    this._thumbnailIdleCallbackId = null;
                    run();
                }, { timeout: 400 });
            } else {
                run();
            }
        }, 160);
    }

    _updateWindowTitle() {
        const title = this._getWindowTitle();
        this.options.window.title = title;
        const titleElement = this.element?.closest(".application")?.querySelector(".window-title");
        if (titleElement) titleElement.textContent = title;
    }

    _isCacheDebugEnabled() {
        try {
            return game.settings.get("asset-librarian", "debugCacheLogs") === true;
        } catch (_err) {
            return false;
        }
    }

    _debugCache(message, extra = undefined) {
        if (!this._isCacheDebugEnabled()) return;
        if (extra === undefined) console.log(`Asset Librarian | ${message}`);
        else console.log(`Asset Librarian | ${message}`, extra);
    }

    _scheduleMainRender(delay = 0, { recompute = false } = {}) {
        clearTimeout(this._mainRenderTimeout);
        this._mainRenderTimeout = setTimeout(() => {
            if (recompute) {
                this._resetBatching();
                this._applyFilters();
            }
            this.render({ parts: ["main"] });
        }, delay);
    }

    _filterFolderTreeByQuery(folders, query) {
        const clean = foundry.applications.ux.SearchFilter.cleanQuery(query || "").toLocaleLowerCase();
        if (!clean) return folders;
        if (!Array.isArray(folders) || !folders.length) return [];

        return folders.reduce((acc, folder) => {
            const children = this._filterFolderTreeByQuery(folder.children || [], clean);
            const name = foundry.applications.ux.SearchFilter.cleanQuery(folder.name || "").toLocaleLowerCase();
            if (name.includes(clean) || children.length) {
                acc.push({
                    ...folder,
                    children,
                });
            }
            return acc;
        }, []);
    }

    openView(mode = null, tab = null, options = null) {
        let normalizedMode = mode === "compendium" ? "compendium" : mode === "world" ? "world" : this.mode;
        if (normalizedMode !== "compendium" && normalizedMode !== "world") normalizedMode = "world";
        this._pendingOpenFilterRequest = this._normalizeOpenFilterRequest(options);
        this._resetBulkSelection({ disableMode: true });
        const requestedTab = this._canonicalizeTabName(tab);
        if (!requestedTab) {
            const pref = this._getDefaultOpenPreference();
            if (pref?.tab) {
                const prefEnabledTabs = this._getEnabledTabs(pref.mode);
                if (prefEnabledTabs.includes(pref.tab)) normalizedMode = pref.mode;
            } else {
                const lastPref = this._getLastOpenPreference();
                if (lastPref?.tab) {
                    const lastEnabledTabs = this._getEnabledTabs(lastPref.mode);
                    if (lastEnabledTabs.includes(lastPref.tab)) normalizedMode = lastPref.mode;
                }
            }
        }

        const enabledTabs = this._getEnabledTabs(normalizedMode);
        if (!enabledTabs.length) {
            this.mode = normalizedMode;
            this.activeTab = "";
            this.activeFolderId = null;
            this.activeCategoryGroup = "All";
            this.searchQuery = "";
            this._lastComputedFilterStateKey = null;
            this._resetBatching();
            this.wrappedOnResetFilters();
            if (!this._hasShownNoTabsWarning) {
                ui.notifications.warn(game.i18n.localize("ASSET_LIBRARIAN.Empty.NoTabsEnabled"));
                this._hasShownNoTabsWarning = true;
            }
            return this.render(true);
        }
        this._hasShownNoTabsWarning = false;
        const defaultPref = this._getDefaultOpenPreference();
        const lastPref = this._getLastOpenPreference();
        const canonicalDefaultTab = defaultPref?.mode === normalizedMode ? defaultPref.tab : "";
        const canonicalLastTab = lastPref?.mode === normalizedMode ? lastPref.tab : "";
        const nextTab =
            requestedTab && enabledTabs.includes(requestedTab)
                ? requestedTab
                : canonicalDefaultTab && enabledTabs.includes(canonicalDefaultTab)
                  ? canonicalDefaultTab
                : canonicalLastTab && enabledTabs.includes(canonicalLastTab)
                  ? canonicalLastTab
                : enabledTabs[0] ?? "Actor";

        this.mode = normalizedMode;
        this.activeTab = nextTab;
        this.activeFolderId = null;
        this.activeCategoryGroup = nextTab === "Item" ? "Character" : "All";
        this._setLastOpenPreference(this.mode, this.activeTab);
        this.searchQuery = "";
        this.folderSearchQuery = "";
        this._lastComputedFilterStateKey = null;
        this._resetBatching();
        this.wrappedOnResetFilters();
        return this.render(true);
    }
    /**
     * Invalidate cached asset/folder snapshots.
     * @param {{mode?: string, tab?: string}} [opts]
     */
    invalidateDataCache(opts = {}) {
        const { mode, tab } = opts;
        if (!mode && !tab) {
            this._dataCache.clear();
            this._filterOptionsCache.clear();
            this._folderVisibilityCache.clear();
            this._tagRegistrySyncKeys.clear();
            this._dataVersion += 1;
            this._debugCache("Cleared all data and filter caches");

            return;
        }

        for (const key of this._dataCache.keys()) {
            const [cacheMode, cacheTab] = key.split(":");
            if ((mode && cacheMode !== mode) || (tab && cacheTab !== tab)) continue;
            this._dataCache.delete(key);
        }

        for (const key of this._filterOptionsCache.keys()) {
            const [cacheMode, cacheTab] = key.split(":");
            if ((mode && cacheMode !== mode) || (tab && cacheTab !== tab)) continue;
            this._filterOptionsCache.delete(key);
        }
        for (const key of this._folderVisibilityCache.keys()) {
            const [cacheMode, cacheTab] = key.split("|");
            if ((mode && cacheMode !== mode) || (tab && cacheTab !== tab)) continue;
            this._folderVisibilityCache.delete(key);
        }        
        for (const key of this._tagRegistrySyncKeys) {
            const [cacheMode, cacheTab] = key.split(":");
            if ((mode && cacheMode !== mode) || (tab && cacheTab !== tab)) continue;
            this._tagRegistrySyncKeys.delete(key);
        }
        this._dataVersion += 1;
        this._debugCache("Invalidated scoped caches", { mode, tab });
    }

    _invalidateFilterOptionsCacheForTab(tab) {
        for (const key of this._filterOptionsCache.keys()) {
            const [, cacheTab] = key.split(":");
            if (cacheTab !== tab) continue;
            this._filterOptionsCache.delete(key);
        }
    }


    _getFilterCacheKey() {
        const search = this.searchQuery
            ? foundry.applications.ux.SearchFilter.cleanQuery(this.searchQuery).toLocaleLowerCase()
            : "";
        return `${this.mode}:${this.activeTab}:category=${this.activeCategoryGroup}:folder=${this.activeFolderId || "all"}:dupes=${this.showDuplicates ? 1 : 0}:search=${search}`;
    }

    _getFolderVisibilityCacheKey() {
        const search = this.searchQuery
            ? foundry.applications.ux.SearchFilter.cleanQuery(this.searchQuery).toLocaleLowerCase()
            : "";
        return [
            this.mode,
            this.activeTab,
            `cat=${this.activeCategoryGroup}`,
            `dupes=${this.showDuplicates ? 1 : 0}`,
            `search=${search}`,
            `filters=${this._getActiveFilterSelectionKey()}`,
            `dataV=${this._dataVersion}`,
        ].join("|");
    }

    _getAssetsForFolderVisibilityCached() {
        const key = this._getFolderVisibilityCacheKey();
        const hit = this._folderVisibilityCache.get(key);
        if (hit) return hit;

        const computed = this._getAssetsForFolderVisibility();
        this._folderVisibilityCache.set(key, computed);

        const MAX_FOLDER_VIS_CACHE_ENTRIES = 12;
        while (this._folderVisibilityCache.size > MAX_FOLDER_VIS_CACHE_ENTRIES) {
            const oldestKey = this._folderVisibilityCache.keys().next().value;
            this._folderVisibilityCache.delete(oldestKey);
        }
        return computed;
    }


    _getActiveFilterSelectionKey() {
        const selections = [];
        for (const filter of this.filters) {
            for (const value of filter.values) {
                if (value.state !== "off") {
                    selections.push(`${filter.key}:${value.value}:${value.state}`);
                }
            }
        }
        selections.sort();
        return selections.join("|");
    }

    _getFilterStateKey() {
        return `${this._getFilterCacheKey()}:selections=${this._getActiveFilterSelectionKey()}:dataV=${this._dataVersion}`;
    }

    _hasActiveFilterSelections() {
        return this.filters.some((f) => f.values.some((v) => v.state !== "off"));
    }

    _applyBatching() {
        this.renderedAssets = this.filteredAssets.slice(0, this._batchIndex);
    }

    _resetBatching() {
        this._batchIndex = AssetLibrarian.BATCHING.SIZE;
        this._applyBatching();
    }

    async _loadAssetData() {
        const key = this._getDataCacheKey();
        const cached = this._dataCache.get(key);
        if (cached) {
            this.allAssets = cached.assets;
            this.folderTree = cached.folderTree;
            this._debugCache(`Data cache HIT (${key})`, {
                assets: this.allAssets.length,
                folders: this.folderTree.length,
            });
            return;
        }
        this._debugCache(`Data cache MISS (${key})`);

        if (this.activeTab === "Image") {
            this.allAssets = ImageScanner.getCachedImages();
            this.folderTree = ImageScanner.buildFolderTree(this.allAssets);
            this.filters = [];
            const imageLoadToken = ++this._imageLoadToken;
            if (!this.allAssets.length) {
                ImageScanner.hydrateCacheFromDisk().then((hydratedImages) => {
                    if (imageLoadToken !== this._imageLoadToken) return;
                    const hydrated = Array.isArray(hydratedImages) ? hydratedImages : [];
                    if (!hydrated.length) return;
                    const hydratedTree = ImageScanner.buildFolderTree(hydrated);
                    this._dataCache.set(this._getDataCacheKey(this.mode, "Image"), {
                        assets: hydrated,
                        folderTree: hydratedTree,
                    });
                    if (this.activeTab !== "Image" || !this.rendered) return;
                    this.allAssets = hydrated;
                    this.folderTree = hydratedTree;
                    this._lastComputedFilterStateKey = null;
                    this._applyFilters();
                    this.render();
                });
            }
            ImageScanner.startBackgroundScan().then((images) => {
                if (imageLoadToken !== this._imageLoadToken) return;
                const nextAssets = Array.isArray(images) ? images : [];
                this._pruneThumbnailManifestForCurrentImages(nextAssets);
                const nextFolderTree = ImageScanner.buildFolderTree(nextAssets);
                this._dataCache.set(this._getDataCacheKey(this.mode, "Image"), {
                    assets: nextAssets,
                    folderTree: nextFolderTree,
                });
                if (this.activeTab !== "Image" || !this.rendered) return;
                this.allAssets = nextAssets;
                this.folderTree = nextFolderTree;
                this._lastComputedFilterStateKey = null;
                this._applyFilters();
                this.render();
            });
        } else {
            this.allAssets = await DataManager.getAssets(this.activeTab, this.mode === "world");
            this.folderTree = await DataManager.getFolderTree(this.activeTab, this.mode === "world");
            const syncKey = `${this.mode}:${this.activeTab}`;
            if (!this._tagRegistrySyncKeys.has(syncKey)) {
                await this._syncTagRegistryFromAssets(this.activeTab, this.allAssets);
                this._tagRegistrySyncKeys.add(syncKey);
            }
        }

        this._dataCache.set(key, {
            assets: this.allAssets,
            folderTree: this.folderTree,
        });
        this._debugCache(`Stored data cache (${key})`, {
            assets: this.allAssets.length,
            folders: this.folderTree.length,
        });        
    }

    _canDragStart(selector) {
        // return game.user.isGM;
        return true;
    }

    _canDragDrop(selector) {
        return game.user.isGM;
        // return true;
    }

    /**
     * Handle drag start - set the transfer data
     * @param {DragEvent} event
     */
    _onDragStart(event) {
        const target = event.currentTarget;
        const uuid = target.dataset.uuid;
        if (!uuid) return;

        const asset = this.filteredAssets.find((a) => a.uuid === uuid);
        if (!asset) return;

        if (this.activeTab === "Image") {
            event.dataTransfer.setData(
                "text/plain",
                JSON.stringify({
                    type: "Image",
                    src: asset.img,
                    fromAssetLibrarian: true,
                }),
            );
        } else {
            event.dataTransfer.setData(
                "text/plain",
                JSON.stringify({
                    type: this.activeTab,
                    uuid: uuid,
                }),
            );
        }
    }

    #filterableItems = [];

    #createDragDropHandlers() {
        return this.options.dragDrop.map((d) => {
            d.permissions = {
                dragstart: this._canDragStart.bind(this),
                drop: this._canDragDrop.bind(this),
            };
            d.callbacks = {
                dragstart: this._onDragStart.bind(this),
            };
            return new DragDrop(d);
        });
    }

    #dragDrop;

    get dragDrop() {
        return this.#dragDrop;
    }

    static DEFAULT_OPTIONS = {
        id: "asset-librarian",
        classes: ["asset-librarian", "filter-panel-collapsed", "folder"],
        dragDrop: [{ dragSelector: "[data-drag], .draggable", dropSelector: null }],
        window: {
            title: "ASSET_LIBRARIAN.Title",
            resizable: true,
            icon: "fas fa-book",
        },
        position: {
            width: 1000,
            height: 700,
        },
        actions: {
            switchTab: AssetLibrarian.#onSwitchTab,
            toggleMode: AssetLibrarian.#onToggleMode,
            toggleDuplicates: AssetLibrarian.#onToggleDuplicates,
            selectFolder: AssetLibrarian.#onSelectFolder,
            toggleFolderNode: AssetLibrarian.#onToggleFolderNode,
            deleteAsset: AssetLibrarian.#onDeleteAsset,
            openSettings: AssetLibrarian.#onOpenSettings,
            toggleFilter: AssetLibrarian.#onToggleFilter,
            resetFilters: AssetLibrarian.#onResetFilters,
            refreshImages: AssetLibrarian.#onRefreshImages,
            configureImages: AssetLibrarian.#onConfigureImages,
            viewAsset: AssetLibrarian.#onViewAsset,
            toggleFilterPanel: AssetLibrarian.#onToggleFilterPanel,
            toggleFolderPanel: AssetLibrarian.#onToggleFolderPanel,
            changeViewMode: AssetLibrarian.#onChangeViewMode,
            configureFilters: AssetLibrarian.#onConfigureFilters,
            toggleCategoryBar: AssetLibrarian.#onToggleCategoryBar,
            selectCategoryGroup: AssetLibrarian.#onSelectCategoryGroup,
            openCategoryConfig: AssetLibrarian.#onOpenCategoryConfig,
            openTagGroupConfig: AssetLibrarian.#onOpenTagGroupConfig,
            toggleBulkSelectMode: AssetLibrarian.#onToggleBulkSelectMode,
            clearBulkSelection: AssetLibrarian.#onClearBulkSelection,
            applyBulkEditSelected: AssetLibrarian.#onApplyBulkEditSelected,
        },
    };

    static PARTS = {
        main: {
            template: "modules/asset-librarian/templates/asset-librarian.hbs",
            scrollable: ["", ".scrollable", ".folder-tree", ".filter-panel-content"],
        },
    };

    /** @override */
    async _prepareContext(options) {
        this._captureFilterGroupOpenStateFromDOM();
        const baseTabs = this._getEnabledTabs();
        if (!baseTabs.length) {
            if (!this._hasShownNoTabsWarning) {
                ui.notifications.warn(game.i18n.localize("ASSET_LIBRARIAN.Empty.NoTabsEnabled"));
                this._hasShownNoTabsWarning = true;
            }
            return {
                tabs: [],
                activeTab: "",
                mode: this.mode,
                isWorld: this.mode === "world",
                isImageTab: false,
                isScanning: this.isScanning,
                showDuplicates: this.showDuplicates,
                isGM: game.user.isGM,
                viewMode: this.viewMode,
                assets: [],
                folders: [],
                filters: [],
                folderPanelOpen: game.user.getFlag("asset-librarian", "folderPanelOpen") ?? true,
                filterPanelOpen: game.user.getFlag("asset-librarian", "filterPanelOpen") ?? true,
                searchQuery: this.searchQuery,
                activeFolderId: this.activeFolderId,
                assetCount: 0,
                totalCount: 0,
                activeCategoryGroup: "All",
                categoryGroups: null,
                noTabsEnabled: true,
            };
        }
        this._hasShownNoTabsWarning = false;


        if (!baseTabs.includes(this.activeTab)) {
            this.activeTab = baseTabs[0] ?? "Actor";
            this.activeFolderId = null;
            this.activeCategoryGroup = this.activeTab === "Item" ? "Character" : "All";
            this._lastComputedFilterStateKey = null;
            this._resetBatching();
        }
        await this._loadAssetData();
        const categoryGroups = this._getCategoryGroups();
        if (Array.isArray(categoryGroups) && categoryGroups.length) {
            const hasActiveGroup = categoryGroups.some((g) => g.id === this.activeCategoryGroup);
            if (!hasActiveGroup) this.activeCategoryGroup = categoryGroups[0].id;
        } else {
            this.activeCategoryGroup = "All";
        }

        const filterStateKey = this._getFilterStateKey();
        if (this._lastComputedFilterStateKey !== filterStateKey) {
            this._applyFilters();
            this._lastComputedFilterStateKey = filterStateKey;
        } else {
            this._applyBatching();
        }
        if (this._applyPendingOpenFilterRequest()) {
            this._lastComputedFilterStateKey = null;
            this._applyFilters();
        }


        const defaultPref = this._getDefaultOpenPreference();
        const tabs = baseTabs.map((type) => ({
            id: type,
            label: game.i18n.localize(`ASSET_LIBRARIAN.Tabs.${type}`),
            active: this.activeTab === type,
            cssClass: this.activeTab === type ? "active" : "",
            isDefault: defaultPref?.mode === this.mode && defaultPref?.tab === type,
        }));

        const isImageTab = this.activeTab === "Image";

        const hasActiveFilters = this.filters.some((f) => f.values.some((v) => v.state !== "off"));
        
        const hasActiveCategorySelection =
            this.activeCategoryGroup !== "All" &&
            (this.activeTab === "Actor" || this.activeTab === "Item" || supportsFlagTagsForTab(this.activeTab));
         const shouldFilterFolders = this.searchQuery || hasActiveFilters || hasActiveCategorySelection || this.showDuplicates;
        const folderVisibilityAssets = this.activeFolderId ? this._getAssetsForFolderVisibilityCached() : this.filteredAssets;


        let displayFolders;
        if (shouldFilterFolders) {
            const assetFolderIds = new Set();
            for (const asset of folderVisibilityAssets) {
                if (asset.folder) assetFolderIds.add(asset.folder);
                if (asset.pack) assetFolderIds.add(asset.pack);
            }
            displayFolders = this._filterFolderTree(this.folderTree, assetFolderIds);
        } else {
            const assetFolderIds = new Set();
            for (const asset of this.allAssets) {
                if (asset.folder) assetFolderIds.add(asset.folder);
                if (asset.pack) assetFolderIds.add(asset.pack);
            }
            displayFolders = this._filterFolderTree(this.folderTree, assetFolderIds);
        


        }
        displayFolders = this._filterFolderTreeByQuery(displayFolders, this.folderSearchQuery);

        const showTagLockIndicators = this.bulkSelectMode && game.user.isGM && supportsFlagTagsForTab(this.activeTab);

        return {
            tabs,
            activeTab: this.activeTab,
            mode: this.mode,
            isWorld: this.mode === "world",
            isImageTab,
            isScanning: this.isScanning,
            showDuplicates: this.showDuplicates,
            isGM: game.user.isGM,
            canBulkTagEdit: game.user.isGM && supportsFlagTagsForTab(this.activeTab) && this.filteredAssets.length > 0,
            bulkSelectMode: this.bulkSelectMode,
            selectedAssetCount: this.selectedAssetUuids.size,
            bulkEditTargetLabel: this.selectedAssetUuids.size
                ? String(this.selectedAssetUuids.size)
                : game.i18n.localize("ASSET_LIBRARIAN.Categories.All"),
            viewMode: this.viewMode,
            assets: this.renderedAssets.map((asset) => ({
                ...asset,
                _displayImg: this._getAssetDisplayImage(asset),
                _isSelected: this.selectedAssetUuids.has(asset.uuid),
                _isTagEditLocked: showTagLockIndicators ? !this._canEditTagsForEntry(asset.uuid, this.activeTab) : false,
            })),
            folders: this._decorateFolderTree(displayFolders),
            filters: this.filters.map((group, index) => ({
                ...group,
                open: this._isFilterGroupOpen(`${group.key}::${this.activeTab}::${this.activeCategoryGroup}`, index),
            })),
            folderPanelOpen: game.user.getFlag("asset-librarian", "folderPanelOpen") ?? true,
            filterPanelOpen: game.user.getFlag("asset-librarian", "filterPanelOpen") ?? true,
            searchQuery: this.searchQuery,
            folderSearchQuery: this.folderSearchQuery,
            activeFolderId: this.activeFolderId,
            assetCount: this.filteredAssets.length,
            totalCount: this.allAssets.length,
            thumbnailBuildActive:
                this._thumbnailBuildActive && this._thumbnailBuildTotal > 0 && this._shouldGenerateThumbnailsForTab(this.activeTab),
            thumbnailBuildDone: this._thumbnailBuildDone,
            thumbnailBuildTotal: this._thumbnailBuildTotal,
            activeCategoryGroup: this.activeCategoryGroup,
            categoryGroups,
            unavailableCompendiumCustomFilters: this._getUnavailableCompendiumCustomFilters(),

        };
    }

    _captureFilterGroupOpenStateFromDOM() {
        if (!this.element) return;
        const groups = this.element.querySelectorAll("details.filter-group[data-filter-group-key]");
        for (const group of groups) {
            const rawGroupKey = group.dataset.filterGroupKey;
            const groupKey = typeof rawGroupKey === "string" ? rawGroupKey.replace(/\s+/g, "") : "";
            if (!groupKey) continue;
            this._setFilterGroupOpenState(groupKey, group.open);
        }
    }

    _parseCustomTagFilterGroupKey(filterKey) {
        if (typeof filterKey !== "string") return null;
        const match = /^filterTagGroup:([^:]+):(.+)$/.exec(filterKey);
        if (!match) return null;
        return { docType: match[1], groupId: match[2] };
    }

    _loadPersistedFilterGroupOrderByTab() {
        const raw = game.user.getFlag("asset-librarian", FILTER_GROUP_ORDER_FLAG_KEY);
        if (!raw || typeof raw !== "object") return {};
        const out = {};
        for (const [tab, order] of Object.entries(raw)) {
            if (!Array.isArray(order)) continue;
            const seen = new Set();
            out[tab] = order
                .map((key) => (typeof key === "string" ? key.trim() : ""))
                .filter((key) => key && !seen.has(key) && seen.add(key));
        }
        return out;
    }

    _orderFiltersForActiveTab(filters) {
        if (!Array.isArray(filters) || !filters.length) return [];
        const order = Array.isArray(this._filterGroupOrderByTab?.[this.activeTab]) ? this._filterGroupOrderByTab[this.activeTab] : [];
        if (!order.length) return filters;
        const byKey = new Map(filters.map((filter) => [filter.key, filter]));
        const ordered = [];
        for (const key of order) {
            const filter = byKey.get(key);
            if (!filter) continue;
            ordered.push(filter);
            byKey.delete(key);
        }
        ordered.push(...byKey.values());
        return ordered;
    }

    _loadPersistedFilterGroupOpenState() {
        const raw = game.user.getFlag("asset-librarian", FILTER_GROUP_OPEN_STATE_FLAG_KEY);
        const map = new Map();
        if (!raw || typeof raw !== "object") return map;
        for (const [key, value] of Object.entries(raw)) {
            const normalizedKey = typeof key === "string" ? key.replace(/\s+/g, "") : "";
            if (!normalizedKey) continue;
            map.set(normalizedKey, value === true);
        }
        return map;
    }

    _setFilterGroupOpenState(groupKey, isOpen) {
        const normalizedGroupKey = typeof groupKey === "string" ? groupKey.replace(/\s+/g, "") : "";
        if (!normalizedGroupKey) return;
        const next = isOpen === true;
        if (this._filterGroupOpenState.get(normalizedGroupKey) === next) return;
        this._filterGroupOpenState.set(normalizedGroupKey, next);
        this._schedulePersistFilterGroupOpenState();
    }

    _schedulePersistFilterGroupOpenState() {
        if (this._filterGroupOpenStatePersistTimeout) clearTimeout(this._filterGroupOpenStatePersistTimeout);
        this._filterGroupOpenStatePersistTimeout = setTimeout(async () => {
            this._filterGroupOpenStatePersistTimeout = null;
            const payload = Object.fromEntries(this._filterGroupOpenState.entries());
            try {
                await game.user.setFlag("asset-librarian", FILTER_GROUP_OPEN_STATE_FLAG_KEY, payload);
            } catch (_err) {
                // Ignore client persistence errors.
            }
        }, 150);
    }

    _setFilterGroupOrderForActiveTab(filterKeys) {
        if (!Array.isArray(filterKeys) || !filterKeys.length) return false;
        const seen = new Set();
        const normalized = filterKeys
            .map((key) => (typeof key === "string" ? key.trim() : ""))
            .filter((key) => key && !seen.has(key) && seen.add(key));
        if (!normalized.length) return false;
        const current = Array.isArray(this._filterGroupOrderByTab?.[this.activeTab]) ? this._filterGroupOrderByTab[this.activeTab] : [];
        if (JSON.stringify(current) === JSON.stringify(normalized)) return false;
        this._filterGroupOrderByTab[this.activeTab] = normalized;
        this._schedulePersistFilterGroupOrderByTab();
        return true;
    }

    _schedulePersistFilterGroupOrderByTab() {
        if (this._filterGroupOrderPersistTimeout) clearTimeout(this._filterGroupOrderPersistTimeout);
        this._filterGroupOrderPersistTimeout = setTimeout(async () => {
            this._filterGroupOrderPersistTimeout = null;
            try {
                await game.user.setFlag("asset-librarian", FILTER_GROUP_ORDER_FLAG_KEY, this._filterGroupOrderByTab);
            } catch (_err) {
                // Ignore client persistence errors.
            }
        }, 150);
    }

    _bindFilterGroupReorderControls() {
        if (!this.element) return;
        const groups = this.element.querySelectorAll("details.filter-group[data-filter-key]");
        for (const group of groups) {
            const handle = group.querySelector("summary.filter-label");
            if (!handle) continue;
            handle.draggable = true;

            handle.addEventListener("dragstart", (event) => {
                this._draggedFilterGroupEl = group;
                group.classList.add("is-dragging");
                if (event.dataTransfer) {
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData("text/plain", group.dataset.filterKey || "");
                }
            });

            handle.addEventListener("dragend", () => {
                this._draggedFilterGroupEl = null;
                this._clearFilterGroupDropHints();
            });

            group.addEventListener("dragover", (event) => {
                const source = this._draggedFilterGroupEl;
                if (!source || source === group) return;
                event.preventDefault();
                const rect = group.getBoundingClientRect();
                const before = (event.clientY - rect.top) < rect.height / 2;
                group.classList.toggle("drop-before", before);
                group.classList.toggle("drop-after", !before);
                if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
            });

            group.addEventListener("dragleave", () => {
                group.classList.remove("drop-before", "drop-after");
            });

            group.addEventListener("drop", (event) => {
                event.preventDefault();
                const source = this._draggedFilterGroupEl;
                if (!source || source === group) return;
                const parent = group.parentElement;
                if (!parent) return;
                const rect = group.getBoundingClientRect();
                const before = (event.clientY - rect.top) < rect.height / 2;
                if (before) parent.insertBefore(source, group);
                else parent.insertBefore(source, group.nextElementSibling);
                this._clearFilterGroupDropHints();
                this._persistFilterGroupOrderFromSidebarDOM();
            });
        }
    }

    _clearFilterGroupDropHints() {
        if (!this.element) return;
        const groups = this.element.querySelectorAll("details.filter-group[data-filter-key]");
        for (const group of groups) {
            group.classList.remove("drop-before", "drop-after", "is-dragging");
        }
    }

    async _persistFilterGroupOrderFromSidebarDOM() {
        if (this._isPersistingFilterGroupOrder || !this.element) return;
        const orderFromDOM = Array.from(this.element.querySelectorAll("details.filter-group[data-filter-key]"))
            .map((el) => (el.dataset.filterKey || "").trim())
            .filter(Boolean);
        if (!orderFromDOM.length) return;

        const changed = this._setFilterGroupOrderForActiveTab(orderFromDOM);
        if (!changed) return;

        this._isPersistingFilterGroupOrder = true;
        try {
            await this._syncCustomGroupOrderFromFilterKeys(orderFromDOM);
            this._lastComputedFilterStateKey = null;
            this._applyFilters();
            this.render();
        } finally {
            this._isPersistingFilterGroupOrder = false;
        }
    }

    async _syncCustomGroupOrderFromFilterKeys(filterKeys) {
        const docType = this.activeTab;
        if (!supportsFlagTagsForTab(docType)) return;
        const customGroupIdsInOrder = [];
        for (const filterKey of filterKeys) {
            const parsed = this._parseCustomTagFilterGroupKey(filterKey);
            if (!parsed || parsed.docType !== docType) continue;
            customGroupIdsInOrder.push(parsed.groupId);
        }
        if (!customGroupIdsInOrder.length) return;

        const config = game.settings.get("asset-librarian", "tagGroupConfig") || {};
        const currentCustomOrder = getOrderedTagGroupsForDocType(config, docType).map((entry) => entry.id);
        if (!currentCustomOrder.length) return;

        const customSet = new Set(customGroupIdsInOrder);
        const mergedOrder = [
            ...customGroupIdsInOrder.filter((groupId) => currentCustomOrder.includes(groupId)),
            ...currentCustomOrder.filter((groupId) => !customSet.has(groupId)),
        ];
        if (JSON.stringify(currentCustomOrder) === JSON.stringify(mergedOrder)) return;

        const nextConfig = foundry.utils.deepClone(config);
        nextConfig[docType] ||= { groups: {} };
        nextConfig[docType].groupOrder = mergedOrder;
        await game.settings.set("asset-librarian", "tagGroupConfig", nextConfig);
    }

    _getFlagCategoryTag(asset) {
        return normalizeTag(asset?.flags?.[ASSET_LIBRARIAN_FLAG_SCOPE]?.categoryTag || "");
    }

    _getFlagCategoryToken(asset) {
        return tagToken(this._getFlagCategoryTag(asset));
    }

    _makeTagCategoryGroupId(token) {
        return `${TAG_CATEGORY_GROUP_PREFIX}${token}`;
    }

    _extractTagCategoryToken(groupId) {
        if (typeof groupId !== "string") return null;
        if (!groupId.startsWith(TAG_CATEGORY_GROUP_PREFIX)) return null;
        const token = groupId.slice(TAG_CATEGORY_GROUP_PREFIX.length);
        return token || null;
    }

    _getFlagCategoryGroupsFromAssets() {
        const categoryCounts = new Map();
        const categoryLabels = new Map();
        for (const asset of this.allAssets) {
            const label = this._getFlagCategoryTag(asset);
            if (!label) continue;
            const token = tagToken(label);
            if (!token) continue;
            categoryCounts.set(token, (categoryCounts.get(token) || 0) + 1);
            if (!categoryLabels.has(token)) categoryLabels.set(token, label);
        }

        return Array.from(categoryCounts.entries())
            .map(([token, count]) => ({
                id: this._makeTagCategoryGroupId(token),
                label: categoryLabels.get(token) || token,
                count,
            }))
            .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
    }


    _getTagRegistry() {
        return game.settings.get("asset-librarian", ASSET_LIBRARIAN_TAG_REGISTRY_SETTING) || {};
    }

    _getTagRegistryForTab(tab) {
        const registry = this._getTagRegistry();
        const tabEntry = registry?.[tab] || {};
        return {
            categories: normalizeTagList(tabEntry.categories || []),
            filters: normalizeTagList(tabEntry.filters || []),
        };
    }

    async _syncTagRegistryFromAssets(tab, assets) {
        if (!game.user.isGM || !supportsFlagTagsForTab(tab) || !Array.isArray(assets)) return;

        const fromAssetsCategories = [];
        const fromAssetsFilters = [];

        for (const asset of assets) {
            const category = this._getFlagCategoryTag(asset);
            if (category) fromAssetsCategories.push(category);
            const filters = normalizeTagList(asset?.flags?.[ASSET_LIBRARIAN_FLAG_SCOPE]?.filterTag || []);
            if (filters.length) fromAssetsFilters.push(...filters);
        }

        const incomingCategories = normalizeTagList(fromAssetsCategories);
        const incomingFilters = normalizeTagList(fromAssetsFilters);
        if (!incomingCategories.length && !incomingFilters.length) return;

        const registry = this._getTagRegistry();
        const existing = registry[tab] || {};
        const mergedCategories = normalizeTagList([...(existing.categories || []), ...incomingCategories]);
        const mergedFilters = normalizeTagList([...(existing.filters || []), ...incomingFilters]);
        const sameCategories = JSON.stringify(existing.categories || []) === JSON.stringify(mergedCategories);
        const sameFilters = JSON.stringify(existing.filters || []) === JSON.stringify(mergedFilters);
        if (sameCategories && sameFilters) return;

        const nextRegistry = {
            ...registry,
            [tab]: {
                categories: mergedCategories,
                filters: mergedFilters,
            },
        };
        await game.settings.set("asset-librarian", ASSET_LIBRARIAN_TAG_REGISTRY_SETTING, nextRegistry);
    }

    _applyTagUpdateToLocalCaches(tab, uuid, { categoryTag = "", filterTag = [] } = {}) {
        if (!uuid || !tab) return;

        const applyToAsset = (asset) => {
            if (!asset || asset.uuid !== uuid) return;
            asset.flags ??= {};
            asset.flags[ASSET_LIBRARIAN_FLAG_SCOPE] ??= {};
            if (categoryTag) asset.flags[ASSET_LIBRARIAN_FLAG_SCOPE].categoryTag = categoryTag;
            else delete asset.flags[ASSET_LIBRARIAN_FLAG_SCOPE].categoryTag;
            if (Array.isArray(filterTag) && filterTag.length) asset.flags[ASSET_LIBRARIAN_FLAG_SCOPE].filterTag = filterTag;
            else delete asset.flags[ASSET_LIBRARIAN_FLAG_SCOPE].filterTag;
        };

        for (const [cacheKey, cached] of this._dataCache.entries()) {
            const [, cacheTab] = cacheKey.split(":");
            if (cacheTab !== tab || !Array.isArray(cached?.assets)) continue;
            for (const asset of cached.assets) applyToAsset(asset);
        }

        if (this.activeTab === tab && Array.isArray(this.allAssets)) {
            for (const asset of this.allAssets) applyToAsset(asset);
        }
    }

    _resetBulkSelection({ disableMode = false } = {}) {
        this.selectedAssetUuids.clear();
        if (disableMode) this.bulkSelectMode = false;
    }

    _syncBulkSelectionToFilteredAssets() {
        if (!this.selectedAssetUuids.size) return;
        const valid = new Set(this.filteredAssets.map((a) => a.uuid));
        for (const uuid of Array.from(this.selectedAssetUuids)) {
            if (!valid.has(uuid)) this.selectedAssetUuids.delete(uuid);
        }
    }

    _getSelectedAssetsForBulkEdit() {
        if (!this.selectedAssetUuids.size) return [];
        const byUuid = new Map(this.filteredAssets.map((a) => [a.uuid, a]));
        const selected = [];
        for (const uuid of this.selectedAssetUuids) {
            const asset = byUuid.get(uuid);
            if (asset) selected.push(asset);
        }
        return selected;
    }

    _getUnavailableCompendiumCustomFilters() {
        if (this.mode !== "compendium" || !this.allAssets?.length) return [];
        const customFieldsByType = game.settings.get("asset-librarian", "customFilterFields") || {};
        const customFields = customFieldsByType[this.activeTab] || [];
        if (!customFields.length) return [];

        const unavailable = [];
        for (const field of customFields) {
            const parsedPath = FilterManager.parsePath(field.path);
            let hasAnyValue = false;
            for (const asset of this.allAssets) {
                let value = FilterManager.getNestedValue(asset, parsedPath);
                if (value === undefined && field.path && asset[field.path] !== undefined) {
                    value = asset[field.path];
                }
                const normalized = FilterManager._normalizeFilterValues(value);
                if (normalized.length) {
                    hasAnyValue = true;
                    break;
                }
            }
            if (!hasAnyValue) unavailable.push(field.label || field.key || field.path);
        }
        return unavailable;
    }

    _getCategoryGroups() {
        if (this.activeTab === "Actor") {
            const typeCounts = new Map();
            for (const asset of this.allAssets) {
                if (!asset?.type) continue;
                typeCounts.set(asset.type, (typeCounts.get(asset.type) || 0) + 1);
            }

            const types = [];
            const actorTypes = Array.isArray(game.system.documentTypes.Actor)
                ? game.system.documentTypes.Actor
                : Object.keys(game.system.documentTypes.Actor);

            for (const type of actorTypes) {
                
                const key = CONFIG.Actor?.typeLabels?.[type];
                const label = (key && game.i18n.has(key)) ? game.i18n.localize(key) : type;
                const count = typeCounts.get(type) || 0;
                types.push({ id: type, label, count });
            }
            types.sort((a, b) => a.label.localeCompare(b.label));
            const updatedTypes = [
                { id: "All", label: game.i18n.localize("ASSET_LIBRARIAN.Categories.All"), count: this.allAssets.length },
                ...types,
                ...(supportsFlagTagsForTab(this.activeTab) ? this._getFlagCategoryGroupsFromAssets() : []),
            ].filter((group) => group.count > 0);
            return updatedTypes;
        } else if (this.activeTab === "Item") {
            const typeCounts = new Map();
            for (const asset of this.allAssets) {
                if (!asset?.type) continue;
                typeCounts.set(asset.type, (typeCounts.get(asset.type) || 0) + 1);
            }

            const categoryConfig = game.settings.get("asset-librarian", "categoryConfig") || {};
            const defaults = CategoryConfigApp.DEFAULT_MAPPINGS[game.system.id] || {};

            const groups = CategoryConfigApp.GROUPS.map((g) => {
                if (g === "All") {
                    return {
                        id: g,
                        label: game.i18n.localize("ASSET_LIBRARIAN.Categories.All"),
                        count: this.allAssets.length,
                    };
                }

                let groupConfig = categoryConfig[g];
                if (!groupConfig && defaults[g]) {
                    groupConfig = {};
                    for (const t of defaults[g]) groupConfig[t] = true;
                }

                let count = 0;
                if (groupConfig) {
                    for (const [type, enabled] of Object.entries(groupConfig)) {
                        if (!enabled) continue;
                        count += typeCounts.get(type) || 0;
                    }
                }

                return { id: g, label: g, count };
            }).filter((group) => group.count > 0);
            if (supportsFlagTagsForTab(this.activeTab)) {
                groups.push(...this._getFlagCategoryGroupsFromAssets());
            }
            return groups;
        } else if (supportsFlagTagsForTab(this.activeTab)) {
            const groups = [
                { id: "All", label: game.i18n.localize("ASSET_LIBRARIAN.Categories.All"), count: this.allAssets.length },
                ...this._getFlagCategoryGroupsFromAssets(),
            ].filter((group) => group.count > 0);

            return groups;
        }
        return null;
    }

  _getAssetsForFolderVisibility() {
        let assets = [...this.allAssets];
        const activeTagCategoryToken = this._extractTagCategoryToken(this.activeCategoryGroup);

        if ((["Actor", "Item"].includes(this.activeTab) || supportsFlagTagsForTab(this.activeTab)) && this.activeCategoryGroup !== "All") {
            if (activeTagCategoryToken) {
                assets = assets.filter((a) => this._getFlagCategoryToken(a) === activeTagCategoryToken);
            } else if (this.activeTab === "Actor") {
                assets = assets.filter((a) => a.type === this.activeCategoryGroup);
            } else if (this.activeTab === "Item") {
                const categoryConfig = game.settings.get("asset-librarian", "categoryConfig") || {};
                let groupConfig = categoryConfig[this.activeCategoryGroup];
                if (!groupConfig && CategoryConfigApp.DEFAULT_MAPPINGS[game.system.id]?.[this.activeCategoryGroup]) {
                    groupConfig = {};
                    CategoryConfigApp.DEFAULT_MAPPINGS[game.system.id][this.activeCategoryGroup].forEach((t) => (groupConfig[t] = true));
                }
                if (groupConfig) {
                    assets = assets.filter((a) => !!groupConfig[a.type]);
                }
            } else if (supportsFlagTagsForTab(this.activeTab)) {
                assets = assets.filter((a) => this._getFlagCategoryToken(a) === this.activeCategoryGroup);
            }
        }

        if (this.showDuplicates) {
            const duplicates = DataManager.findDuplicates(assets);
            assets = Object.values(duplicates).flat();
        }

        if (this.searchQuery) {
            const query = foundry.applications.ux.SearchFilter.cleanQuery(this.searchQuery).toLocaleLowerCase();
            assets = assets.filter((a) =>
                foundry.applications.ux.SearchFilter.cleanQuery(a.name || "").toLocaleLowerCase().includes(query),
            );
        }

        return FilterManager.applyFilters(assets, this.filters);
    }


    _applyFilters() {
        let assets = [...this.allAssets];
        const activeTagCategoryToken = this._extractTagCategoryToken(this.activeCategoryGroup);

        if ((["Actor", "Item"].includes(this.activeTab) || supportsFlagTagsForTab(this.activeTab)) && this.activeCategoryGroup !== "All") {
            if (activeTagCategoryToken) {
                assets = assets.filter((a) => this._getFlagCategoryToken(a) === activeTagCategoryToken);
            } else if (this.activeTab === "Actor") {
                assets = assets.filter((a) => a.type === this.activeCategoryGroup);
            } else if (this.activeTab === "Item") {
                const categoryConfig = game.settings.get("asset-librarian", "categoryConfig") || {};

                let groupConfig = categoryConfig[this.activeCategoryGroup];

                if (!groupConfig && CategoryConfigApp.DEFAULT_MAPPINGS[game.system.id]?.[this.activeCategoryGroup]) {
                    groupConfig = {};
                    CategoryConfigApp.DEFAULT_MAPPINGS[game.system.id][this.activeCategoryGroup].forEach(
                        (t) => (groupConfig[t] = true),
                    );
                }

                if (groupConfig) {
                    assets = assets.filter((a) => {
                        const assetType = a.type;
                        if (!assetType) return false;
                        return !!groupConfig[assetType];
                    });
                }
            } else if (supportsFlagTagsForTab(this.activeTab)) {
                assets = assets.filter((a) => this._getFlagCategoryToken(a) === this.activeCategoryGroup);
            }
        }

        if (this.showDuplicates) {
            const duplicates = DataManager.findDuplicates(assets);
            assets = Object.values(duplicates).flat();
        }

        if (this.activeFolderId) {
            if (this.activeFolderId === "root") {
                assets = assets.filter((a) => !a.folder);
            } else if (this.activeFolderId.startsWith("source:")) {
                assets = assets.filter((a) => a.packSource === this.activeFolderId);
            } else {
                const includeNested = game.settings.get("asset-librarian", "showNestedFolderContent") === true;
                if (includeNested) {
                    const validFolderIds = this._getFolderSubtreeIds(this.activeFolderId);
                    assets = assets.filter((a) => validFolderIds.has(a.folder) || a.pack === this.activeFolderId);
                } else {
                    assets = assets.filter((a) => a.folder === this.activeFolderId || a.pack === this.activeFolderId);
                }
            }
        }

        if (this.searchQuery) {
            const query = foundry.applications.ux.SearchFilter.cleanQuery(this.searchQuery).toLocaleLowerCase();
            assets = assets.filter((a) =>
                foundry.applications.ux.SearchFilter.cleanQuery(a.name || "").toLocaleLowerCase().includes(query),
            );
        }

        const filteredAssets = FilterManager.applyFilters(assets, this.filters);
        const hasActiveSelections = this._hasActiveFilterSelections();
        const filterCacheKey = this._getFilterCacheKey();
        let cachedFilters = !hasActiveSelections ? this._filterOptionsCache.get(filterCacheKey) : null;
        if (!hasActiveSelections) {
            this._debugCache(`Filter options cache ${cachedFilters ? "HIT" : "MISS"} (${filterCacheKey})`);
        }
        if (cachedFilters && !cachedFilters.length && filteredAssets.length) {
            cachedFilters = null;
            this._filterOptionsCache.delete(filterCacheKey);
            this._debugCache(`Dropped stale empty filter cache (${filterCacheKey})`);
        }

        const newFilters = cachedFilters
            ? foundry.utils.deepClone(cachedFilters)
            : FilterManager.buildFilters(filteredAssets, this.activeTab);

        if (!hasActiveSelections && !cachedFilters && newFilters.length) {
            this._filterOptionsCache.set(filterCacheKey, foundry.utils.deepClone(newFilters));
            this._debugCache(`Stored filter options cache (${filterCacheKey})`, { groups: newFilters.length });
        }
        const newFiltersByKey = new Map(newFilters.map((f) => [f.key, f]));
        const assetsForGroupCache = new Map();

        for (const existingFilter of this.filters) {
            const hasActiveSelection = existingFilter.values.some((v) => v.state !== "off");
            const newFilter = newFiltersByKey.get(existingFilter.key);

            if (hasActiveSelection) {
                let assetsForThisGroup = assetsForGroupCache.get(existingFilter.key);
                if (!assetsForThisGroup) {
                    const otherFilters = this.filters.filter((f) => f.key !== existingFilter.key);
                    assetsForThisGroup = FilterManager.applyFilters(assets, otherFilters);
                    assetsForGroupCache.set(existingFilter.key, assetsForThisGroup);
                }

                const groupOptions = FilterManager.buildFilterGroup(assetsForThisGroup, this.activeTab, existingFilter.key);

                if (groupOptions) {
                    for (const existingValue of existingFilter.values) {
                        const optionValue = groupOptions.values.find((v) => v.value === existingValue.value);
                        if (optionValue) {
                            optionValue.state = existingValue.state || "off";
                        }
                    }

                    newFiltersByKey.set(existingFilter.key, groupOptions);
                }
            } else if (newFilter) {
                for (const existingValue of existingFilter.values) {
                    const newValue = newFilter.values.find((v) => v.value === existingValue.value);
                    if (newValue) {
                        newValue.state = existingValue.state || "off";
                    }
                }
            }
        }

        this.filters = this._orderFiltersForActiveTab(Array.from(newFiltersByKey.values()));
        this.filteredAssets = filteredAssets;
        this._syncBulkSelectionToFilteredAssets();
        this._resetBatching();
        this._lastComputedFilterStateKey = this._getFilterStateKey();
    }

    /** @override */
    _onRender(context, options) {
        this._updateWindowTitle();
    
        const content = this.element.querySelector(".asset-grid");
        if (content) {
            this.#filterableItems = [];
            for (const element of content.querySelectorAll("div.asset-card")) {
                const name = element.dataset.name;
                if (name) {
                    this.#filterableItems.push({
                        element: element,
                        name: foundry.applications.ux.SearchFilter.cleanQuery(name),
                        uuid: element.dataset.uuid,
                    });
                }
            }
        }

        this._bindSearchInputControl();
        this._bindFolderSearchInputControl();

        for (const handler of this.#dragDrop) {
            handler.bind(this.element);
        }
        this._setupLazyLoading();
        this._scheduleRenderedThumbnailHydration();
        this._bindSearchClearControl();
        this._bindBatchScrollHandlers();
        this._bindBatchResizeObserver();
        this._restoreSearchInputState();
        this._restoreFolderSearchInputState();
        this._updateThumbnailBuildStatusDOM();
        if (this._preserveScrollTop !== null) {
            const container = this.element.querySelector(".asset-grid-container");
            if (container) container.scrollTop = this._preserveScrollTop;
            this._preserveScrollTop = null;
            this._batchThrottle = false;
        }

        const filterTags = this.element.querySelectorAll(".filter-tag");
        for (const tag of filterTags) {
            tag.addEventListener("contextmenu", (event) => {
                event.preventDefault();
                event.stopPropagation();
                const filterKey = tag.dataset.filterKey;
                const filterValue = tag.dataset.filterValue;

                const filter = this.filters.find((f) => f.key === filterKey);
                if (filter) {
                    const valueObj = filter.values.find((v) => v.value === filterValue);
                    if (valueObj) {
                        valueObj.state = valueObj.state === "off" ? "exclude" : "off";
                        this._scheduleMainRender(50, { recompute: true });
                    }
                }
            });
        }
        const filterGroups = this.element.querySelectorAll("details.filter-group[data-filter-group-key]");
        for (const group of filterGroups) {
            const rawGroupKey = group.dataset.filterGroupKey;
            const groupKey = typeof rawGroupKey === "string" ? rawGroupKey.replace(/\s+/g, "") : "";
            if (!groupKey) continue;
            group.addEventListener("toggle", () => {
                this._setFilterGroupOpenState(groupKey, group.open);
            });
        }
        this._bindFilterGroupReorderControls();

        this._updateAssetVisibility();
        this._ensureScrollableGridByAppending();
    }

    _isFilterGroupOpen(groupKey, index) {
        const normalizedGroupKey = typeof groupKey === "string" ? groupKey.replace(/\s+/g, "") : "";
        if (this._filterGroupOpenState.has(normalizedGroupKey)) {
            return this._filterGroupOpenState.get(normalizedGroupKey) === true;
        }

        const openTags = Number(game.settings.get("asset-librarian", "openTags") ?? 3);
        if (openTags === 0) return true; 
        return index < openTags;
    }

    _bindSearchClearControl() {
        const input = this.element.querySelector("input[name='searchFilter']");
        const clearBtn = this.element.querySelector(".search-clear");
        if (!input || !clearBtn) return;

        const updateClearButton = () => {
            clearBtn.classList.toggle("hidden", !input.value);
        };

        input.addEventListener("input", updateClearButton);
        updateClearButton();

        clearBtn.addEventListener("click", () => {
            if (!input.value) return;
            input.value = "";
            this.searchQuery = "";
            updateClearButton();
            this._scheduleMainRender(0, { recompute: true });
            input.focus();
        });
    }

    _bindSearchInputControl() {
        const input = this.element.querySelector("input[name='searchFilter']");
        if (!input) return;
        input.addEventListener("input", (event) => {
            clearTimeout(this._searchTimeout);
            this._searchTimeout = setTimeout(() => {
                this._searchInputState = {
                    value: event.target.value,
                    start: event.target.selectionStart ?? event.target.value.length,
                    end: event.target.selectionEnd ?? event.target.value.length,
                    direction: event.target.selectionDirection ?? "none",
                };
                this.searchQuery = event.target.value;
                this._scheduleMainRender(0, { recompute: true });
            }, 220);
        });
    }

    _restoreSearchInputState() {
        if (!this._searchInputState) return;
        const input = this.element.querySelector("input[name='searchFilter']");
        if (!input) {
            this._searchInputState = null;
            return;
        }

        const state = this._searchInputState;
        if (input.value !== state.value) {
            this._searchInputState = null;
            return;
        }

        input.focus({ preventScroll: true });
        try {
            input.setSelectionRange(state.start, state.end, state.direction);
        } catch (_err) {
            input.setSelectionRange(state.start, state.end);
        }
        this._searchInputState = null;
    }

    _bindFolderSearchInputControl() {
        const input = this.element.querySelector("input[name='folderSearch']");
        if (!input) return;
        input.addEventListener("input", (event) => {
            clearTimeout(this._folderSearchTimeout);
            this._folderSearchTimeout = setTimeout(() => {
                this._folderSearchInputState = {
                    value: event.target.value,
                    start: event.target.selectionStart ?? event.target.value.length,
                    end: event.target.selectionEnd ?? event.target.value.length,
                    direction: event.target.selectionDirection ?? "none",
                };
                this.folderSearchQuery = event.target.value;
                this._scheduleMainRender(0);
            }, 200);
        });
    }

    _restoreFolderSearchInputState() {
        if (!this._folderSearchInputState) return;
        const input = this.element.querySelector("input[name='folderSearch']");
        if (!input) {
            this._folderSearchInputState = null;
            return;
        }

        const state = this._folderSearchInputState;
        if (input.value !== state.value) {
            this._folderSearchInputState = null;
            return;
        }

        input.focus({ preventScroll: true });
        try {
            input.setSelectionRange(state.start, state.end, state.direction);
        } catch (_err) {
            input.setSelectionRange(state.start, state.end);
        }
        this._folderSearchInputState = null;
    }

    _bindBatchScrollHandlers() {
        if (this.renderedAssets.length >= this.filteredAssets.length) return;
        const container = this.element.querySelector(".asset-grid-container");
        if (!container) return;
        container.addEventListener("scroll", () => {
            if (this._batchScrollRaf) return;
            this._batchScrollRaf = requestAnimationFrame(() => {
                this._batchScrollRaf = null;
                if (this._batchThrottle) return;
                const nearBottom =
                    container.scrollTop + container.clientHeight >=
                    container.scrollHeight - AssetLibrarian.BATCHING.MARGIN;
                if (!nearBottom) return;
                if (this.renderedAssets.length >= this.filteredAssets.length) return;
                this._batchThrottle = true;
                const nextBatchIndex = Math.min(
                    this._batchIndex + AssetLibrarian.BATCHING.SIZE,
                    this.filteredAssets.length,
                );
                const appended = this._appendBatchToGrid(nextBatchIndex);
                if (!appended) {
                    this._batchIndex = nextBatchIndex;
                    this._preserveScrollTop = container.scrollTop;
                    this._scheduleMainRender(0);
                } else {
                    this._batchThrottle = false;
                }
            });
        }, { passive: true });
    }

    _bindBatchResizeObserver() {
        if (typeof globalThis.ResizeObserver !== "function") return;
        const container = this.element?.querySelector(".asset-grid-container");
        if (!container) return;

        if (!this._batchResizeObserver) {
            this._batchResizeObserver = new globalThis.ResizeObserver(() => {
                if (this._batchFillRaf) return;
                this._batchFillRaf = requestAnimationFrame(() => {
                    this._batchFillRaf = null;
                    this._ensureScrollableGridByAppending();
                });
            });
        }

        this._batchResizeObserver.disconnect();
        this._batchResizeObserver.observe(container);
    }

    _ensureScrollableGridByAppending() {
        if (this.renderedAssets.length >= this.filteredAssets.length) return;
        const container = this.element?.querySelector(".asset-grid-container");
        if (!container) return;
        if (container.clientHeight <= 0) return;

        const scrollableDistance = container.scrollHeight - container.clientHeight;
        const hasOverflow = scrollableDistance > 1;
        if (hasOverflow) return;

        const nextBatchIndex = Math.min(
            this._batchIndex + AssetLibrarian.BATCHING.SIZE,
            this.filteredAssets.length,
        );
        const appended = this._appendBatchToGrid(nextBatchIndex);
        if (!appended) return;

        if (this._batchFillRaf) cancelAnimationFrame(this._batchFillRaf);
        this._batchFillRaf = requestAnimationFrame(() => {
            this._batchFillRaf = null;
            this._ensureScrollableGridByAppending();
        });
    }

    _appendBatchToGrid(nextBatchIndex) {
        if (!this.element) return false;
        if (!Number.isFinite(nextBatchIndex) || nextBatchIndex <= this._batchIndex) return false;
        const grid = this.element.querySelector(".asset-grid");
        if (!grid) return false;

        const previousLength = this.renderedAssets.length;
        const nextRenderedAssets = this.filteredAssets.slice(0, nextBatchIndex);
        const appendedAssets = nextRenderedAssets.slice(previousLength);
        if (!appendedAssets.length) return false;

        this._batchIndex = nextBatchIndex;
        this.renderedAssets = nextRenderedAssets;

        const emptyState = grid.querySelector(".no-assets");
        if (emptyState) emptyState.remove();

        const fragment = document.createDocumentFragment();
        const newCards = [];
        for (const asset of appendedAssets) {
            const card = this._createAssetCardElement(asset);
            newCards.push(card);
            fragment.appendChild(card);
            const name = card.dataset.name;
            if (name) {
                this.#filterableItems.push({
                    element: card,
                    name: foundry.applications.ux.SearchFilter.cleanQuery(name),
                    uuid: card.dataset.uuid,
                });
            }
        }
        grid.appendChild(fragment);
        this._observeLazyImagesInCards(newCards);
        this._scheduleRenderedThumbnailHydration();
        return true;
    }

    _createAssetCardElement(asset) {
        const card = document.createElement("div");
        card.className = `asset-card ${this.selectedAssetUuids.has(asset.uuid) ? "selected" : ""}`.trim();
        card.dataset.uuid = asset.uuid;
        card.dataset.action = "viewAsset";
        card.dataset.documentType = this.activeTab;
        card.dataset.entryId = asset.id;
        card.dataset.name = asset.name || "";
        card.draggable = true;
        card.dataset.drag = "true";

        const thumb = document.createElement("div");
        thumb.className = "asset-thumb";
        const img = document.createElement("img");
        img.src = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
        img.dataset.src = this._getAssetDisplayImage(asset);
        img.alt = asset.name || "";
        img.loading = "lazy";
        img.onerror = () => {
            img.src = "icons/svg/mystery-man.svg";
        };
        thumb.appendChild(img);

        const info = document.createElement("div");
        info.className = "asset-info";
        const nameSpan = document.createElement("span");
        nameSpan.className = "asset-name";
        nameSpan.title = asset.name || "";
        nameSpan.textContent = asset.name || "";
        info.appendChild(nameSpan);

        const actions = document.createElement("div");
        actions.className = "asset-card-actions";
        const showTagLockIndicators = this.bulkSelectMode && game.user.isGM && supportsFlagTagsForTab(this.activeTab);
        if (showTagLockIndicators && !this._canEditTagsForEntry(asset.uuid, this.activeTab)) {
            const lock = document.createElement("i");
            lock.className = "fas fa-lock asset-lock-icon";
            lock.title = game.i18n.localize("ASSET_LIBRARIAN.Tagging.NoPermission");
            actions.appendChild(lock);
        }
        if (this.showDuplicates) {
            const deleteBtn = document.createElement("button");
            deleteBtn.type = "button";
            deleteBtn.className = "delete-btn";
            deleteBtn.dataset.action = "deleteAsset";
            deleteBtn.dataset.uuid = asset.uuid;
            const icon = document.createElement("i");
            icon.className = "fas fa-trash";
            deleteBtn.appendChild(icon);
            actions.appendChild(deleteBtn);
        }
        info.appendChild(actions);

        card.append(thumb, info);
        return card;
    }

    _observeLazyImagesInCards(cards) {
        if (!Array.isArray(cards) || !cards.length) return;
        const pending = [];
        for (const card of cards) {
            const img = card?.querySelector?.(".asset-thumb img");
            if (!img) continue;
            img.addEventListener("error", () => {
                void this._onAssetImageLoadError(img);
            });
            if (img.dataset.src) pending.push(img);
        }
        if (!this._lazyLoadObserver) return;
        for (const img of pending) {
            this._lazyLoadObserver.observe(img);
        }
    }

    /** @override */
    async _onFirstRender(context, options) {
        await super._onFirstRender(context, options);
        this._createContextMenus();
        this._updateWindowTitle();

        const filterPanelCollapsed = game.user.getFlag("asset-librarian", "filterPanelOpen") ?? true;
        const folderPanelCollapsed = game.user.getFlag("asset-librarian", "folderPanelOpen") ?? true;

        this.element
            .querySelector(".asset-librarian-container")
            .classList.toggle("filter-panel-collapsed", filterPanelCollapsed);
        const filterIcon = this.element.querySelector(".filter-panel-collapser i");
        if (filterIcon) {
            filterIcon.classList.remove("fa-caret-left", "fa-caret-right");
            filterIcon.classList.add(`fa-caret-${filterPanelCollapsed ? "left" : "right"}`);
        }

        this.element
            .querySelector(".asset-librarian-container")
            .classList.toggle("folder-panel-collapsed", folderPanelCollapsed);
        const folderIcon = this.element.querySelector(".folder-panel-collapser i");
        if (folderIcon) {
            folderIcon.classList.remove("fa-caret-left", "fa-caret-right");
            folderIcon.classList.add(`fa-caret-${folderPanelCollapsed ? "right" : "left"}`);
        }
    }

    async _onSendToPlayer(item) {
        if (!item) {
            ui.notifications.warn(game.i18n.localize("ASSET_LIBRARIAN.Notifications.ItemNotFound"));
            return;
        }
        helpers.createPlayerSelectionDialog(item.name, async (targetActor) => {
            await helpers.transferItemToActor(item, targetActor);
        });
    }
    /**
     * Register context menu entries and fire hooks.
     * @protected
     */
   _createContextMenus() {
        const SELECTORS = {
            TAB_BUTTON: ".asset-tabs .tab-btn",
            COMPENDIUM_FOLDER_ITEM: ".folder-tree .folder-item[data-pack-collection]",
            IMAGE_CARD: ".asset-card[data-document-type='Image']:not([data-uuid^='Compendium'])",
            ACTOR_CARD: ".asset-card[data-document-type='Actor']:not([data-uuid^='Compendium'])",
            COMPENDIUM_ACTOR: ".asset-card[data-uuid^='Compendium'].asset-card[data-document-type='Actor']",
            COMPENDIUM_ADVENTURE: ".asset-card[data-uuid^='Compendium'].asset-card[data-document-type='Adventure']",
            MACRO_CARD: ".asset-card[data-document-type='Macro']:not([data-uuid^='Compendium'])",
            COMPENDIUM_MACRO: ".asset-card[data-uuid^='Compendium'].asset-card[data-document-type='Macro']",
            PLAYLIST_CARD: ".asset-card[data-document-type='Playlist']:not([data-uuid^='Compendium'])",
            COMPENDIUM_PLAYLIST: ".asset-card[data-uuid^='Compendium'].asset-card[data-document-type='Playlist']",
            CARDS_CARD: ".asset-card[data-document-type='Cards']:not([data-uuid^='Compendium'])",
            COMPENDIUM_CARDS: ".asset-card[data-uuid^='Compendium'].asset-card[data-document-type='Cards']",
            ROLLTABLE_CARD: ".asset-card[data-document-type='RollTable']:not([data-uuid^='Compendium'])",
            COMPENDIUM_ROLLTABLE: ".asset-card[data-uuid^='Compendium'].asset-card[data-document-type='RollTable']",
            JOURNAL_CARD: ".asset-card[data-document-type='JournalEntry']:not([data-uuid^='Compendium'])",
            COMPENDIUM_JOURNAL: ".asset-card[data-uuid^='Compendium'].asset-card[data-document-type='JournalEntry']",
            ITEM_CARD: ".asset-card[data-document-type='Item']:not([data-uuid^='Compendium'])",
            COMPENDIUM_ITEM: ".asset-card[data-uuid^='Compendium'].asset-card[data-document-type='Item']",
            SCENE_CARD: ".asset-card[data-document-type='Scene']:not([data-uuid^='Compendium'])",
            COMPENDIUM_SCENE: ".asset-card[data-uuid^='Compendium'].asset-card[data-document-type='Scene']",
            COMPENDIUM: ".asset-card[data-uuid^='Compendium']",
        };
        this._createContextMenu(this._getItemContextOptions, SELECTORS.ITEM_CARD, {
            fixed: true,
            hookName: `get${this.documentName}ContextOptions`,
            parentClassHooks: false,
        });
        this._createContextMenu(this._getActorContextOptions, SELECTORS.ACTOR_CARD, {
            fixed: true,
            hookName: `get${this.documentName}ContextOptions`,
            parentClassHooks: false,
        });
        this._createContextMenu(this._getJournalContextOptions, SELECTORS.JOURNAL_CARD, {
            fixed: true,
            hookName: `get${this.documentName}ContextOptions`,
            parentClassHooks: false,
        });
        this._createContextMenu(this._getMacroContextOptions, SELECTORS.MACRO_CARD, {
            fixed: true,
            hookName: `get${this.documentName}ContextOptions`,
            parentClassHooks: false,
        });
        this._createContextMenu(this._getPlaylistContextOptions, SELECTORS.PLAYLIST_CARD, {
            fixed: true,
            hookName: `get${this.documentName}ContextOptions`,
            parentClassHooks: false,
        });
        this._createContextMenu(this._getRollTableContextOptions, SELECTORS.ROLLTABLE_CARD, {
            fixed: true,
            hookName: `get${this.documentName}ContextOptions`,
            parentClassHooks: false,
        });
        this._createContextMenu(this._getCardsContextOptions, SELECTORS.CARDS_CARD, {
            fixed: true,
            hookName: `get${this.documentName}ContextOptions`,
            parentClassHooks: false,
        });
        this._createContextMenu(this._getImageContextOptions, SELECTORS.IMAGE_CARD, {
            fixed: true,
            hookName: `get${this.documentName}ContextOptions`,
            parentClassHooks: false,
        });
        this._createContextMenu(this._getSceneContextOptions, SELECTORS.SCENE_CARD, {
            fixed: true,
            hookName: `get${this.documentName}ContextOptions`,
            parentClassHooks: false,
        });
        this._createContextMenu(this._getMacroCompendiumContextOptions, SELECTORS.COMPENDIUM_MACRO, {
            fixed: true,
            hookName: `get${this.documentName}ContextOptions`,
            parentClassHooks: false,
        });
        this._createContextMenu(this._getAdventureCompendiumContextOptions, SELECTORS.COMPENDIUM_ADVENTURE, {
            fixed: true,
            hookName: `get${this.documentName}ContextOptions`,
            parentClassHooks: false,
        });
        this._createContextMenu(this._getPlaylistCompendiumContextOptions, SELECTORS.COMPENDIUM_PLAYLIST, {
            fixed: true,
            hookName: `get${this.documentName}ContextOptions`,
            parentClassHooks: false,
        });
        this._createContextMenu(this._getCardsCompendiumContextOptions, SELECTORS.COMPENDIUM_CARDS, {
            fixed: true,
            hookName: `get${this.documentName}ContextOptions`,
            parentClassHooks: false,
        });
        this._createContextMenu(this._getRollTableCompendiumContextOptions, SELECTORS.COMPENDIUM_ROLLTABLE, {
            fixed: true,
            hookName: `get${this.documentName}ContextOptions`,
            parentClassHooks: false,
        });
        this._createContextMenu(this._getItemCompendiumContextOptions, SELECTORS.COMPENDIUM_ITEM, {
            fixed: true,
            hookName: `get${this.documentName}ContextOptions`,
            parentClassHooks: false,
        });
        this._createContextMenu(this._getActorCompendiumContextOptions, SELECTORS.COMPENDIUM_ACTOR, {
            fixed: true,
            hookName: `get${this.documentName}ContextOptions`,
            parentClassHooks: false,
        });
        this._createContextMenu(this._getSceneCompendiumContextOptions, SELECTORS.COMPENDIUM_SCENE, {
            fixed: true,
            hookName: `get${this.documentName}ContextOptions`,
            parentClassHooks: false,
        });
        this._createContextMenu(this._getJournalCompendiumContextOptions, SELECTORS.COMPENDIUM_JOURNAL, {
            fixed: true,
            hookName: `get${this.documentName}ContextOptions`,
            parentClassHooks: false,
        });
        this._createContextMenu(this._getCompendiumContextOptions, SELECTORS.COMPENDIUM, {
            fixed: true,
            hookName: `get${this.documentName}ContextOptions`,
            parentClassHooks: false,
        });
        this._createContextMenu(this._getCompendiumFolderContextOptions, SELECTORS.COMPENDIUM_FOLDER_ITEM, {
            fixed: true,
            hookName: `get${this.documentName}FolderContextOptions`,
            parentClassHooks: false,
        });
        this._createContextMenu(this._getTabContextOptions, SELECTORS.TAB_BUTTON, {
            fixed: true,
            hookName: `get${this.documentName}TabContextOptions`,
            parentClassHooks: false,
        });
    }
    // COMPENDIUM
        /** @inheritDoc */
    _getCompendiumContextOptions() {
        return [GET_IMPORT_TO_WORLD(), this._getShowFolderContextOption()];
    }

    _getCompendiumFolderContextOptions() {
        return [
            {
                name: game.i18n.localize("ASSET_LIBRARIAN.Buttons.OpenCompendium"),
                icon: '<i class="fa-solid fa-book-open"></i>',
                condition: (li) => !!li?.dataset?.packCollection && !!game.packs.get(li.dataset.packCollection),
                callback: (li) => this._openCompendiumFromFolderContext(li),
            },
        ];
    }

    _getTabContextOptions() {
        return [
            {
                name: game.i18n.localize("ASSET_LIBRARIAN.Tabs.SetDefault"),
                icon: '<i class="fas fa-star"></i>',
                condition: (li) => {
                    const tab = li?.dataset?.tab;
                    const pref = this._getDefaultOpenPreference();
                    return !!tab && !(pref?.mode === this.mode && pref?.tab === tab);
                },
                callback: async (li) => {
                    const tab = li?.dataset?.tab;
                    if (!tab) return;
                    await game.settings.set("asset-librarian", DEFAULT_OPEN_VIEW_SETTING_KEY, `${this.mode}:${tab}`);
                    if (this.rendered) this.render();
                },
            },
            {
                name: game.i18n.localize("ASSET_LIBRARIAN.Tabs.ClearDefault"),
                icon: '<i class="fas fa-star-half-stroke"></i>',
                condition: (li) => {
                    const tab = li?.dataset?.tab;
                    const pref = this._getDefaultOpenPreference();
                    return !!tab && pref?.mode === this.mode && pref?.tab === tab;
                },
                callback: async () => {
                    await game.settings.set("asset-librarian", DEFAULT_OPEN_VIEW_SETTING_KEY, "");
                    if (this.rendered) this.render();
                },
            },
        ];
    }


    //ITEMS
    /** @inheritDoc */
    _getItemContextOptions() {
        return [GET_SEND_TO_PLAYER(this), GET_ITEM_VIEW_ART(), GET_CONFIGURE_OWNERSHIP(), this._getShowFolderContextOption(), this._getEditTagsContextOption("Item")];
    }

    /** @inheritDoc */
    _getItemCompendiumContextOptions() {
        return [GET_SEND_TO_PLAYER(this), GET_IMPORT_TO_WORLD(), this._getShowFolderContextOption(), this._getEditTagsContextOption("Item")];
    }

    //Adventures
    /** @inheritDoc */
    _getAdventureCompendiumContextOptions() {
        return [this._getShowFolderContextOption(), this._getEditTagsContextOption("Item")];
    }

    //CARDS

    /** @inheritDoc */
    _getCardsCompendiumContextOptions() {
        return [
            GET_CARDS_DRAW_DIALOG(),
            GET_CARDS_PASS_DIALOG(),
            GET_CARDS_DEAL_DIALOG(),
            GET_CARDS_SHUFFLE(),
            GET_IMPORT_TO_WORLD(),
            this._getShowFolderContextOption(),
            this._getEditTagsContextOption("Cards"),
        ];
    }

    /** @inheritDoc */
    _getCardsContextOptions() {
        return [
            GET_CARDS_DRAW_DIALOG(),
            GET_CARDS_PASS_DIALOG(),
            GET_CARDS_DEAL_DIALOG(),
            GET_CARDS_SHUFFLE(),
            GET_CONFIGURE_OWNERSHIP(),
            this._getShowFolderContextOption(),
            this._getEditTagsContextOption("Cards"),
        ];
    }


    // JOURNALS
    /** @inheritDoc */
    _getJournalCompendiumContextOptions() {
        return [GET_IMPORT_TO_WORLD(), this._getShowFolderContextOption(), this._getEditTagsContextOption("JournalEntry")];
    }
    /** @inheritDoc */
    _getJournalContextOptions() {
        return [GET_JUMP_TO_PIN(), GET_CONFIGURE_OWNERSHIP(), this._getShowFolderContextOption(), this._getEditTagsContextOption("JournalEntry")];
    }

    //PLAYLIST
    /** @inheritDoc */
    _getPlaylistCompendiumContextOptions() {
        return [GET_IMPORT_TO_WORLD(), this._getShowFolderContextOption(), this._getEditTagsContextOption("Playlist")];
    }
    /** @inheritDoc */
    _getPlaylistContextOptions() {
        return [GET_PLAYLIST_BULK_IMPORT(), GET_CONFIGURE_OWNERSHIP(), this._getShowFolderContextOption(), this._getEditTagsContextOption("Playlist")];
    }

    // ACTOR
    /** @inheritDoc */
    _getActorContextOptions() {
        return [GET_ACTOR_CHARACTER_ART(), GET_ACTOR_TOKEN_ART(), GET_CONFIGURE_OWNERSHIP(), this._getShowFolderContextOption(), this._getEditTagsContextOption("Actor")];
    }
    /** @inheritDoc */
    _getActorCompendiumContextOptions() {
        return [GET_IMPORT_TO_WORLD(), this._getShowFolderContextOption(), this._getEditTagsContextOption("Actor")];
    }
    // MACRO
    /** @inheritDoc */
    _getMacroContextOptions() {
        return [GET_EXECUTE_MACRO(), GET_CONFIGURE_OWNERSHIP(), this._getShowFolderContextOption(), this._getEditTagsContextOption("Macro")];
    }
    /** @inheritDoc */
    _getMacroCompendiumContextOptions() {
        return [GET_EXECUTE_MACRO(), GET_IMPORT_TO_WORLD(), this._getShowFolderContextOption(), this._getEditTagsContextOption("Macro")];
    }

    //ROLLTABLE
    /** @inheritDoc */
    _getRollTableContextOptions() {
        return [GET_ROLLTABLE_DRAW_RESULT(), GET_CONFIGURE_OWNERSHIP(), this._getShowFolderContextOption(), this._getEditTagsContextOption("RollTable")];
    }
    /** @inheritDoc */
    _getRollTableCompendiumContextOptions() {
        return [GET_ROLLTABLE_DRAW_RESULT(), GET_IMPORT_TO_WORLD(), this._getShowFolderContextOption(), this._getEditTagsContextOption("RollTable")];
    }

    //SCENE
    /** @inheritDoc */
    _getSceneCompendiumContextOptions() {
        return [GET_IMPORT_TO_WORLD(), this._getShowFolderContextOption(), this._getEditTagsContextOption("Scene")];
    }

    /** @inheritDoc */
    _getSceneContextOptions() {
        return [
            {
                name: "SCENE.View",
                icon: '<i class="fa-solid fa-eye"></i>',
                condition: (span) => !canvas.ready || span.dataset.uuid !== canvas.scene.uuid,
                callback: (span) => game.scenes.get(foundry.utils.parseUuid(span.dataset.uuid).id)?.view(),
            },
            {
                name: "SCENE.Activate",
                icon: '<i class="fa-solid fa-bullseye"></i>',
                condition: (span) => game.user.isGM && !game.scenes.get(span.dataset.uuid)?.active,
                callback: (span) => game.scenes.get(foundry.utils.parseUuid(span.dataset.uuid).id)?.activate(),
            },
            {
                name: "SCENE.Configure",
                icon: '<i class="fa-solid fa-gears"></i>',
                callback: (span) =>
                    game.scenes.get(foundry.utils.parseUuid(span.dataset.uuid).id)?.sheet.render({ force: true }),
            },
            {
                name: "SCENE.ToggleNav",
                icon: '<i class="fa-solid fa-compass"></i>',
                condition: (span) =>
                    game.user.isGM && !game.scenes.get(foundry.utils.parseUuid(span.dataset.uuid).id)?.active,
                callback: (span) => {
                    const scene = game.scenes.get(foundry.utils.parseUuid(span.dataset.uuid).id);
                    scene?.update({ navigation: !scene.navigation });
                },
            },
            this._getShowFolderContextOption(),
            this._getEditTagsContextOption("Scene"),
        ].concat();
    }


    /** @inheritDoc */
    _getImageContextOptions() {
        return [
            {
                name: game.i18n.localize("ASSET_LIBRARIAN.Buttons.CreateTile"),
                icon: '<i class="fa-solid fa-cubes"></i>',
                condition: (li) => canvas.ready && foundry.documents.Scene.canUserCreate(game.user),
                callback: (li) => helpers.createTile(li),
            },
            {
                name: game.i18n.localize("ASSET_LIBRARIAN.Buttons.SetBackground"),
                icon: '<i class="fa-solid fa-image"></i>',
                condition: (li) => canvas.ready && foundry.documents.Scene.canUserCreate(game.user),
                callback: (li) => helpers.changeBackground(li),
            },
            {
                name: game.i18n.localize("ASSET_LIBRARIAN.Buttons.CreateScene"),
                icon: '<i class="fa-solid fa-map"></i>',
                condition: (li) => foundry.documents.Scene.canUserCreate(game.user),
                callback: (li) => helpers.createScene(li),
            },
            this._getShowFolderContextOption(),
        ];
    }

    _getShowFolderContextOption() {
        return {
            name: game.i18n.localize("ASSET_LIBRARIAN.Buttons.ShowFolder"),
            icon: '<i class="fa-solid fa-folder-tree"></i>',
            condition: (li) => !!this._getAssetForContextTarget(li),
            callback: (li) => this._openAssetFolderFromContext(li),
        };
    }

    _getAssetForContextTarget(target) {
        const uuid = target?.dataset?.uuid || target?.closest?.("[data-uuid]")?.dataset?.uuid;
        if (!uuid) return null;
        return this.filteredAssets.find((asset) => asset?.uuid === uuid) || this.allAssets.find((asset) => asset?.uuid === uuid) || null;
    }

    _getFolderBranchFromTree(folderId, nodes = this.folderTree, trail = []) {
        if (!folderId || !Array.isArray(nodes) || !nodes.length) return null;
        for (const node of nodes) {
            if (!node) continue;
            const nextTrail = [...trail, node.id];
            if (node.id === folderId) return nextTrail;
            if (Array.isArray(node.children) && node.children.length) {
                const nested = this._getFolderBranchFromTree(folderId, node.children, nextTrail);
                if (nested) return nested;
            }
        }
        return null;
    }

    _expandFolderBranch(folderId) {
        const branch = this._getFolderBranchFromTree(folderId);
        if (!Array.isArray(branch) || !branch.length) return;
        for (const ancestorId of branch.slice(0, -1)) {
            this._folderNodeOpenState.set(ancestorId, true);
        }
    }

    _getAssetFolderId(asset) {
        if (!asset) return null;

        if (this.activeTab === "Image") {
            const folderPath = String(asset.folder || "").trim();
            if (folderPath) return folderPath || "root";
            const src = String(asset.img || "").trim();
            if (src.includes("/")) return src.split("/").slice(0, -1).join("/") || "root";
            return "root";
        }

        const folderId = String(asset.folder || "").trim();
        if (folderId) return folderId;
        if (this.mode === "compendium") {
            const packId = String(asset.pack || "").trim();
            if (packId) return packId;
        }
        return "root";
    }

    _openAssetFolderFromContext(target) {
        const asset = this._getAssetForContextTarget(target);
        const folderId = this._getAssetFolderId(asset);
        if (!folderId) return;
        if (folderId !== "root") this._expandFolderBranch(folderId);
        this.activeFolderId = folderId;
        this._resetBatching();
        this._scheduleMainRender(0, { recompute: true });
    }

    _openCompendiumFromFolderContext(target) {
        const row = target?.closest?.("[data-pack-collection]") ?? target;
        const packCollection = row?.dataset?.packCollection;
        if (!packCollection) return;
        const pack = game.packs.get(packCollection);
        if (!pack) return;
        pack.render(true);
    }

    _getEditTagsContextOption(documentType) {
        return {
            name: game.i18n.localize("ASSET_LIBRARIAN.Tagging.EditTags"),
            icon: '<i class="fa-solid fa-tags"></i>',
            condition: (li) => this._canEditTagsForEntry(li?.dataset?.uuid, documentType),
            callback: (li) => this._openTagEditorForUuid(li?.dataset?.uuid, documentType),
        };
    }
    _getPackCollectionFromUuid(uuid) {
        if (typeof uuid !== "string" || !uuid.startsWith("Compendium.")) return null;
        const parts = uuid.split(".");
        if (parts.length < 4) return null;
        return `${parts[1]}.${parts[2]}`;
    }

    _getEditTagsContextOption(documentType) {
        return {
            name: game.i18n.localize("ASSET_LIBRARIAN.Tagging.EditTags"),
            icon: '<i class="fa-solid fa-tags"></i>',
            condition: (li) => this._canEditTagsForEntry(li?.dataset?.uuid, documentType),
            callback: (li) => this._openTagEditorForUuid(li?.dataset?.uuid, documentType),
        };
    }
    _getPackCollectionFromUuid(uuid) {
        if (typeof uuid !== "string" || !uuid.startsWith("Compendium.")) return null;
        const parts = uuid.split(".");
        if (parts.length < 4) return null;
        return `${parts[1]}.${parts[2]}`;
    }

    _canEditTagsForEntry(uuid, documentType) {
        if (!game.user.isGM || !supportsFlagTagsForTab(documentType)) return false;
        const packCollection = this._getPackCollectionFromUuid(uuid);
        if (!packCollection) return true;
        const pack = game.packs.get(packCollection);
        if (!pack) return false;
        return !pack.locked;
    }

    async _openBulkTagEditorForAssets(documentType, sourceAssets = []) {
        if (!supportsFlagTagsForTab(documentType) || !game.user.isGM) return;

        const workingSet = Array.isArray(sourceAssets) ? sourceAssets : [];
        const candidates = workingSet.filter((asset) => this._canEditTagsForEntry(asset?.uuid, documentType));
        const skippedLocked = workingSet.length - candidates.length;
        if (!candidates.length) {
            ui.notifications.warn(game.i18n.localize("ASSET_LIBRARIAN.Tagging.BulkNoEditable"));
            return;
        }

        const knownTags = this._getTagRegistryForTab(documentType);
        const knownCategoryTags = normalizeTagList([
            ...(knownTags.categories || []),
            ...candidates.map((a) => normalizeTag(a?.flags?.[ASSET_LIBRARIAN_FLAG_SCOPE]?.categoryTag || "")),
        ]);
        const knownFilterTags = normalizeTagList([
            ...(knownTags.filters || []),
            ...candidates.flatMap((a) => normalizeTagList(a?.flags?.[ASSET_LIBRARIAN_FLAG_SCOPE]?.filterTag || [])),
        ]);
        const tagGroupConfig = game.settings.get("asset-librarian", "tagGroupConfig") || {};
        const configuredGroupEntries = getOrderedTagGroupsForDocType(tagGroupConfig, documentType);
        const groupById = new Map(configuredGroupEntries.map((entry) => [entry.id, { id: entry.id, label: entry.label, options: [] }]));
        const tokenToGroupId = new Map();
        for (const group of configuredGroupEntries) {
            for (const token of Object.keys(group.tags || {})) {
                if (!group.tags[token] || tokenToGroupId.has(token)) continue;
                tokenToGroupId.set(token, group.id);
            }
        }
        const commonFilterTokenSet = (() => {
            let common = null;
            for (const asset of candidates) {
                const tokens = new Set(normalizeTagList(asset?.flags?.[ASSET_LIBRARIAN_FLAG_SCOPE]?.filterTag || []).map((t) => tagToken(t)));
                if (common === null) {
                    common = tokens;
                    continue;
                }
                common = new Set(Array.from(common).filter((token) => tokens.has(token)));
            }
            return common || new Set();
        })();
        const commonFilterTags = knownFilterTags.filter((tag) => commonFilterTokenSet.has(tagToken(tag)));
        const ungroupedFilterTagOptions = [];
        for (const value of knownFilterTags) {
            const option = {
                value,
                isCommon: commonFilterTokenSet.has(tagToken(value)),
            };
            const groupId = tokenToGroupId.get(tagToken(value));
            if (groupId && groupById.has(groupId)) {
                groupById.get(groupId).options.push(option);
            } else {
                ungroupedFilterTagOptions.push(option);
            }
        }
       for (const group of groupById.values()) {
            group.options.sort((a, b) => a.value.localeCompare(b.value, undefined, { sensitivity: "base", numeric: true }));
        }
        ungroupedFilterTagOptions.sort((a, b) => a.value.localeCompare(b.value, undefined, { sensitivity: "base", numeric: true }));
        const knownFilterTagGroups = Array.from(groupById.values()).filter((group) => group.options.length > 0);
        const showGroups = knownFilterTagGroups.length >0 ? true: false;
        knownFilterTagGroups.push({
            id: "__ungrouped__",
            label:
                knownFilterTagGroups.length > 0
                    ? game.i18n.localize("ASSET_LIBRARIAN.Tagging.BulkUngroupedTags")
                    : game.i18n.localize("ASSET_LIBRARIAN.Tagging.FilterLabel"),
            options: ungroupedFilterTagOptions,
        });
        const content = await foundry.applications.handlebars.renderTemplate(
            "modules/asset-librarian/templates/bulk-tag-editor.hbs",
            {
                showGroups: showGroups,
                assetCount: candidates.length,
                skippedCount: skippedLocked,
                knownCategoryTags,
                commonFilterTags,
                knownFilterTagGroups,
            },
        );

        const dialog = new foundry.applications.api.DialogV2({
            window: {
                icon: "fas fa-tags",
                title: game.i18n.localize("ASSET_LIBRARIAN.Tagging.BulkWindowTitle"),
                resizable: true,
            },
            position: { width: 640, height: 520 },
            classes: ["asset-librarian", "dialog", "asset-tag-editor-dialog"],
            content,
            buttons: [
                {
                    action: "save",
                    label: game.i18n.localize("ASSET_LIBRARIAN.Tagging.BulkApply"),
                    icon: "fas fa-save",
                    default: true,
                    callback: (_event, _button, app) => {
                        const categoryRaw = app.element.querySelector('input[name="bulkCategoryChoice"]:checked')?.value || "";
                        let categoryMode = "nochange";
                        let categoryValue = "";
                        if (categoryRaw === "__CLEAR__") {
                            categoryMode = "clear";
                        } else if (categoryRaw) {
                            categoryValue = normalizeTag(categoryRaw);
                            if (categoryValue) categoryMode = "set";
                        }
                        const checkedFilterTags = normalizeTagList(
                            Array.from(app.element.querySelectorAll('input[name="bulkFilterAddChoice"]:checked')).map((el) => el.value),
                        );
                        const checkedSet = new Set(checkedFilterTags.map((t) => tagToken(t)));
                        const commonSet = new Set(commonFilterTags.map((t) => tagToken(t)));
                        const addTags = checkedFilterTags.filter((t) => !commonSet.has(tagToken(t)));
                        const removeTags = commonFilterTags.filter((t) => !checkedSet.has(tagToken(t)));
                        const clearFilters = app.element.querySelector('[name="bulkClearFilters"]')?.checked === true;
                        return { categoryMode, categoryValue, addTags, removeTags, clearFilters };
                    },
                },
                {
                    action: "cancel",
                    label: game.i18n.localize("ASSET_LIBRARIAN.Tagging.Cancel"),
                    callback: (_event, _button, app) => {
                        app.close();
                        return null;
                    },
                },
            ],
            submit: async (result) => {
                if (!result) return;

                const hasCategoryChange = result.categoryMode !== "nochange";
                const hasFilterChange = result.clearFilters || result.addTags.length > 0 || result.removeTags.length > 0;
                if (!hasCategoryChange && !hasFilterChange) {
                    ui.notifications.warn(game.i18n.localize("ASSET_LIBRARIAN.Tagging.BulkNoChanges"));
                    return;
                }

                const removeSet = new Set(result.removeTags.map((t) => tagToken(t)));
                const payloadsForRegistry = [];
                let updated = 0;
                let failed = 0;

                let cursor = 0;
                const workers = Array.from({ length: Math.min(4, candidates.length) }, () =>
                    (async () => {
                        while (cursor < candidates.length) {
                            const index = cursor++;
                            const asset = candidates[index];
                            if (!asset?.uuid) continue;
                            try {
                                const doc = await fromUuid(asset.uuid);
                                if (!doc) {
                                    failed += 1;
                                    continue;
                                }

                                const currentCategory = normalizeTag(doc.getFlag(ASSET_LIBRARIAN_FLAG_SCOPE, "categoryTag") || "");
                                const currentFilters = normalizeTagList(doc.getFlag(ASSET_LIBRARIAN_FLAG_SCOPE, "filterTag") || []);

                                let nextCategory = currentCategory;
                                if (result.categoryMode === "clear") nextCategory = "";
                                else if (result.categoryMode === "set") nextCategory = normalizeTag(result.categoryValue);

                                let nextFilters = currentFilters;
                                if (result.clearFilters) nextFilters = [];
                                if (result.addTags.length) nextFilters = normalizeTagList([...nextFilters, ...result.addTags]);
                                if (removeSet.size) nextFilters = nextFilters.filter((t) => !removeSet.has(tagToken(t)));

                                const changedCategory = nextCategory !== currentCategory;
                                const changedFilters = JSON.stringify(nextFilters) !== JSON.stringify(currentFilters);
                                if (!changedCategory && !changedFilters) continue;

                                if (nextCategory) await doc.setFlag(ASSET_LIBRARIAN_FLAG_SCOPE, "categoryTag", nextCategory);
                                else await doc.unsetFlag(ASSET_LIBRARIAN_FLAG_SCOPE, "categoryTag");

                                if (nextFilters.length) await doc.setFlag(ASSET_LIBRARIAN_FLAG_SCOPE, "filterTag", nextFilters);
                                else await doc.unsetFlag(ASSET_LIBRARIAN_FLAG_SCOPE, "filterTag");

                                const payload = { categoryTag: nextCategory, filterTag: nextFilters };
                                payloadsForRegistry.push({ flags: { [ASSET_LIBRARIAN_FLAG_SCOPE]: payload } });
                                DataManager.updateCompendiumCachedAssetTags(asset.uuid, payload);
                                this._applyTagUpdateToLocalCaches(documentType, asset.uuid, payload);
                                updated += 1;
                            } catch (_err) {
                                failed += 1;
                            }
                        }
                    })(),
                );
                await Promise.all(workers);

                if (payloadsForRegistry.length) {
                    await this._syncTagRegistryFromAssets(documentType, payloadsForRegistry);
                }

                this._invalidateFilterOptionsCacheForTab(documentType);
                this._dataVersion += 1;
                this._lastComputedFilterStateKey = null;
                this._applyFilters();
                this.render();

                ui.notifications.info(
                    game.i18n.format("ASSET_LIBRARIAN.Tagging.BulkSummary", {
                        updated,
                        failed,
                        skipped: skippedLocked,
                    }),
                );
            },
        });

        dialog.render(true).then(() => {
            const categoryInput = dialog.element.querySelector('input[name="bulkCategoryInput"]');
            const addInput = dialog.element.querySelector('input[name="bulkFilterAddInput"]');
            const categoryCloud = dialog.element.querySelector(".bulk-category-list");
            const addCloudRoot = dialog.element.querySelector(".bulk-filter-add-root");
            const addButtons = dialog.element.querySelectorAll(".al-tag-add-btn");
            if (!categoryInput || !addInput) return;

            const ensureChip = (kind, value) => {
                const normalizedValue = normalizeTag(value);
                const token = tagToken(normalizedValue);
                if (!token) return null;

                const cloud =
                    kind === "category"
                        ? categoryCloud
                        : addCloudRoot?.querySelector('.bulk-filter-add-list[data-group-id="__ungrouped__"]') ||
                          addCloudRoot?.querySelector(".bulk-filter-add-list");
                const inputName =
                    kind === "category"
                        ? "bulkCategoryChoice"
                        : "bulkFilterAddChoice";
                const inputType = kind === "category" ? "radio" : "checkbox";
                const existing = Array.from(cloud?.querySelectorAll(`input[name="${inputName}"]`) || []).find(
                    (input) => tagToken(input.value || "") === token,
                );
                if (existing) return existing.closest(".al-tag-option");

                const label = document.createElement("label");
                label.className = "compendium-item state-off al-tag-option";
                label.dataset.kind = kind;
                const input = document.createElement("input");
                input.type = inputType;
                input.name = inputName;
                input.value = normalizedValue;
                const span = document.createElement("span");
                span.className = "al-filter-label";
                span.textContent = normalizedValue;
                label.append(input, span);
                cloud?.appendChild(label);
                return label;
            };

            const updateChipState = () => {
                const options = dialog.element.querySelectorAll(".al-tag-option");
                for (const option of options) {
                    const input = option.querySelector("input");
                    const active = !!input?.checked;
                    option.classList.toggle("state-include", active);
                    option.classList.toggle("state-off", !active);
                }
            };

            const addFromInput = (kind, inputEl) => {
                const values = kind === "category" ? [normalizeTag(inputEl.value)] : normalizeTagList(inputEl.value);
                const filtered = values.filter(Boolean);
                if (!filtered.length) return;
                for (const value of filtered) {
                    const option = ensureChip(kind, value);
                    const input = option?.querySelector("input");
                    if (input) input.checked = true;
                }
                inputEl.value = "";
                updateChipState();
            };

            categoryInput.addEventListener("keydown", (event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                addFromInput("category", categoryInput);
            });
            addInput.addEventListener("keydown", (event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                addFromInput("add", addInput);
            });

            for (const btn of addButtons) {
                btn.addEventListener("click", () => {
                    const kind = btn.dataset.kind;
                    if (kind === "category") addFromInput("category", categoryInput);
                    else if (kind === "add") addFromInput("add", addInput);
                });
            }

            dialog.element.addEventListener("change", (event) => {
                const target = event.target;
                if (!(target instanceof HTMLInputElement)) return;
                if (
                    target.name === "bulkCategoryChoice" ||
                    target.name === "bulkFilterAddChoice"
                ) {
                    updateChipState();
                }
            });

            // Allow clicking an already-selected category radio to toggle back to "no change".
            dialog.element.addEventListener("mousedown", (event) => {
                const target = event.target;
                if (!(target instanceof HTMLInputElement)) return;
                if (target.name !== "bulkCategoryChoice") return;
                target.dataset.wasChecked = target.checked ? "1" : "0";
            });
            dialog.element.addEventListener("click", (event) => {
                const target = event.target;
                if (!(target instanceof HTMLInputElement)) return;
                if (target.name !== "bulkCategoryChoice") return;
                if (target.dataset.wasChecked === "1") {
                    target.checked = false;
                    target.dataset.wasChecked = "0";
                    updateChipState();
                }
            });

            updateChipState();
        });
    }

    async _openTagEditorForUuid(uuid, documentType) {
        if (!uuid || !supportsFlagTagsForTab(documentType)) return;
        if (!this._canEditTagsForEntry(uuid, documentType)) {
            ui.notifications.warn(game.i18n.localize("ASSET_LIBRARIAN.Tagging.NoPermission"));
            return;
        }

        const doc = await fromUuid(uuid);
        if (!doc) {
            ui.notifications.warn(game.i18n.localize("ASSET_LIBRARIAN.Tagging.InvalidDocument"));
            return;
        }

        const canEdit = game.user.isGM || doc.isOwner;
        if (!canEdit) {
            ui.notifications.warn(game.i18n.localize("ASSET_LIBRARIAN.Tagging.NoPermission"));
            return;
        }

        const categoryTag = normalizeTag(doc.getFlag(ASSET_LIBRARIAN_FLAG_SCOPE, "categoryTag") || "");
        const filterTagList = normalizeTagList(doc.getFlag(ASSET_LIBRARIAN_FLAG_SCOPE, "filterTag") || []);
        const filterTagTokenSet = new Set(filterTagList.map((t) => tagToken(t)));
        const knownTags = this._getTagRegistryForTab(documentType);
        const knownCategoryTags = normalizeTagList([...(knownTags.categories || []), ...(categoryTag ? [categoryTag] : [])]);
        const knownFilterTags = normalizeTagList([...(knownTags.filters || []), ...filterTagList]);
        const tagGroupConfig = game.settings.get("asset-librarian", "tagGroupConfig") || {};
        const configuredGroupEntries = getOrderedTagGroupsForDocType(tagGroupConfig, documentType);
        const groupById = new Map(configuredGroupEntries.map((entry) => [entry.id, { id: entry.id, label: entry.label, options: [] }]));
        const tokenToGroupId = new Map();
        for (const group of configuredGroupEntries) {
            for (const token of Object.keys(group.tags || {})) {
                if (!group.tags[token] || tokenToGroupId.has(token)) continue;
                tokenToGroupId.set(token, group.id);
            }
        }
        const knownCategoryTagOptions = knownCategoryTags.map((value) => ({
            value,
            checked: tagToken(value) === tagToken(categoryTag),
        }));
        const ungroupedFilterTagOptions = [];
        for (const value of knownFilterTags) {
            const option = {
                value,
                checked: filterTagTokenSet.has(tagToken(value)),
            };
            const groupId = tokenToGroupId.get(tagToken(value));
            if (groupId && groupById.has(groupId)) {
                groupById.get(groupId).options.push(option);
            } else {
                ungroupedFilterTagOptions.push(option);
            }
        }
        for (const group of groupById.values()) {
            group.options.sort((a, b) => a.value.localeCompare(b.value, undefined, { sensitivity: "base", numeric: true }));
        }
        ungroupedFilterTagOptions.sort((a, b) => a.value.localeCompare(b.value, undefined, { sensitivity: "base", numeric: true }));
        const knownFilterTagGroups = Array.from(groupById.values()).filter((group) => group.options.length > 0);
        const showGroups = knownFilterTagGroups.length > 0 ? true: false;

        knownFilterTagGroups.push({
            id: "__ungrouped__",
            label:
                knownFilterTagGroups.length > 0
                    ? game.i18n.localize("ASSET_LIBRARIAN.Tagging.BulkUngroupedTags")
                    : game.i18n.localize("ASSET_LIBRARIAN.Tagging.FilterLabel"),
            options: ungroupedFilterTagOptions,
        });

        const content = await foundry.applications.handlebars.renderTemplate(
            "modules/asset-librarian/templates/tag-editor.hbs",
            {
                showGroups: showGroups,
                knownCategoryTags: knownCategoryTagOptions,
                knownFilterTagGroups,
                categoryNoneChecked: !categoryTag,
            },
        );

        return new Promise((resolve) => {
            const dialog = new foundry.applications.api.DialogV2({
                window: {
                    icon: "fas fa-tags",
                    title: game.i18n.localize("ASSET_LIBRARIAN.Tagging.WindowTitle"),
                    resizable: true,
                },
                position: { width: 600, height: 400 },    
                classes: ["asset-librarian", "asset-tag-editor-dialog"],
                content,
                buttons: [
                    {
                        action: "save",
                        label: game.i18n.localize("ASSET_LIBRARIAN.Tagging.Save"),
                        icon: "fas fa-save",
                        default: true,
                        callback: (_event, _button, app) => {
                            const categoryValue = app.element.querySelector("input[name='categoryTagChoice']:checked")?.value || "";
                            const filterValues = Array.from(app.element.querySelectorAll("input[name='filterTagChoice']:checked"))
                                .map((el) => el.value);
                            return {
                                categoryTag: normalizeTag(categoryValue),
                                filterTag: normalizeTagList(filterValues),
                            };
                        },
                    },
                    {
                        action: "cancel",
                        label: game.i18n.localize("ASSET_LIBRARIAN.Tagging.Cancel"),
                        callback: () => null,
                    },
                ],
                submit: async (result) => {
                    if (result === null) {
                        resolve(null);
                        return;
                    }

                    try {
                        if (result.categoryTag) await doc.setFlag(ASSET_LIBRARIAN_FLAG_SCOPE, "categoryTag", result.categoryTag);
                        else await doc.unsetFlag(ASSET_LIBRARIAN_FLAG_SCOPE, "categoryTag");

                        if (result.filterTag.length) await doc.setFlag(ASSET_LIBRARIAN_FLAG_SCOPE, "filterTag", result.filterTag);
                        else await doc.unsetFlag(ASSET_LIBRARIAN_FLAG_SCOPE, "filterTag");

                        await this._syncTagRegistryFromAssets(documentType, [{ flags: { [ASSET_LIBRARIAN_FLAG_SCOPE]: result } }]);
                        DataManager.updateCompendiumCachedAssetTags(uuid, result);
                        this._applyTagUpdateToLocalCaches(documentType, uuid, result);
                        this._invalidateFilterOptionsCacheForTab(documentType);
                        this._dataVersion += 1;
                        this._lastComputedFilterStateKey = null;
                        this._applyFilters();
                        this.render();
                        ui.notifications.info(game.i18n.localize("ASSET_LIBRARIAN.Tagging.Saved"));
                        resolve(result);
                    } catch (err) {
                        console.warn("Asset Librarian | Failed to update document tags:", err);
                        ui.notifications.warn(game.i18n.localize("ASSET_LIBRARIAN.Tagging.NoPermission"));
                        resolve(null);
                    }
                },
                close: () => resolve(null),
            });
            dialog.render(true).then(() => {
                const categoryInput = dialog.element.querySelector("input[name='categoryTagInput']");
                const filterInput = dialog.element.querySelector("input[name='filterTagInput']");
                const categoryCloudContainer = dialog.element.querySelector(".tag-category-list");
                const filterCloudRoot = dialog.element.querySelector(".tag-filter-root");
                const addButtons = dialog.element.querySelectorAll(".al-tag-add-btn");
                if (!categoryInput || !filterInput) return;

                const ensureChip = (kind, tagValue) => {
                    const token = tagToken(tagValue);
                    if (!token) return null;
                    const selector = `.al-tag-option[data-kind="${kind}"] input`;
                    const root =
                        kind === "category"
                            ? categoryCloudContainer
                            : filterCloudRoot?.querySelector('.tag-filter-list[data-group-id="__ungrouped__"]') ||
                              filterCloudRoot?.querySelector(".tag-filter-list");
                    const inputs = Array.from(root?.querySelectorAll(selector) || []);
                    const existing = inputs.find((input) => tagToken(input.value || "") === token)?.closest(".al-tag-option");
                    if (existing) return existing;
                    const label = document.createElement("label");
                    label.className = "compendium-item state-off al-tag-option";
                    label.dataset.kind = kind;
                    const input = document.createElement("input");
                    input.type = kind === "category" ? "radio" : "checkbox";
                    input.name = kind === "category" ? "categoryTagChoice" : "filterTagChoice";
                    input.value = tagValue;
                    const span = document.createElement("span");
                    span.className = "al-filter-label";
                    span.textContent = tagValue;
                    label.append(input, span);
                    root?.appendChild(label);
                    return label;
                };

                const updateChipState = () => {
                    const options = dialog.element.querySelectorAll(".al-tag-option");
                    for (const option of options) {
                        const input = option.querySelector("input");
                        const active = !!input?.checked;
                        option.classList.toggle("state-include", active);
                        option.classList.toggle("state-off", !active);
                    }
                };

                const addCategoryFromInput = () => {
                    const value = normalizeTag(categoryInput.value);
                    if (!value) return;
                    const option = ensureChip("category", value);
                    const input = option?.querySelector("input[name='categoryTagChoice']");
                    if (input) input.checked = true;
                    categoryInput.value = "";
                    updateChipState();
                };

                const addFilterFromInput = () => {
                    const values = normalizeTagList(filterInput.value);
                    if (!values.length) return;
                    for (const value of values) {
                        const option = ensureChip("filter", value);
                        const input = option?.querySelector("input[name='filterTagChoice']");
                        if (input) input.checked = true;
                    }
                    filterInput.value = "";
                    updateChipState();
                };

                categoryInput.addEventListener("keydown", (event) => {
                    if (event.key !== "Enter") return;
                    event.preventDefault();
                    addCategoryFromInput();
                });
                filterInput.addEventListener("keydown", (event) => {
                    if (event.key !== "Enter") return;
                    event.preventDefault();
                    addFilterFromInput();
                });

                for (const btn of addButtons) {
                    btn.addEventListener("click", () => {
                        const kind = btn.dataset.kind;
                        if (kind === "category") addCategoryFromInput();
                        else addFilterFromInput();
                    });
                }

                dialog.element.addEventListener("change", (event) => {
                    const target = event.target;
                    if (!(target instanceof HTMLInputElement)) return;
                    if (target.name === "categoryTagChoice" || target.name === "filterTagChoice") {
                        updateChipState();
                    }
                });

                updateChipState();
            });
        });
    }


    _setupLazyLoading() {
        const images = this.element.querySelectorAll("img[data-src]");
        const allThumbImages = this.element.querySelectorAll(".asset-card .asset-thumb img");
        for (const img of allThumbImages) {
            img.addEventListener("error", () => {
                void this._onAssetImageLoadError(img);
            });
        }
        this._visibleImageUuids.clear();
        if (this._lazyLoadObserver) {
            this._lazyLoadObserver.disconnect();
            this._lazyLoadObserver = null;
        }
        if (!images.length) return;

        const root = this.element?.querySelector(".asset-grid-container") || null;
        const observer = new IntersectionObserver(
            (entries) => {
                entries.forEach((entry) => {
                    const img = entry.target;
                    const card = img?.closest?.(".asset-card[data-uuid]");
                    const uuid = card?.dataset?.uuid;
                    if (uuid) {
                        if (entry.isIntersecting) this._visibleImageUuids.add(uuid);
                        else this._visibleImageUuids.delete(uuid);
                    }
                    if (entry.isIntersecting) {
                        if (img.dataset.src) {
                            img.src = img.dataset.src;
                            img.removeAttribute("data-src");
                            observer.unobserve(img);
                        }
                    }
                });
            },
            { root, rootMargin: "120px" },
        );

        this._lazyLoadObserver = observer;
        images.forEach((img) => observer.observe(img));

        // Seed top-of-list cards as high priority before observer callbacks fire.
        const seedCards = this.element?.querySelectorAll?.(".asset-card[data-uuid]") || [];
        let seeded = 0;
        for (const card of seedCards) {
            const uuid = card?.dataset?.uuid;
            if (!uuid) continue;
            this._visibleImageUuids.add(uuid);
            seeded += 1;
            if (seeded >= 24) break;
        }
    }

    /**
     * Filter folder tree to only show folders that contain visible assets
     * @param {Array} folders - The folder tree
     * @param {Set} validFolderIds - Set of folder IDs that have visible assets
     * @returns {Array} Filtered folder tree
     */
    _filterFolderTree(folders, validFolderIds) {
        if (!folders || !folders.length) return [];

        return folders.reduce((acc, folder) => {
            const filteredChildren = this._filterFolderTree(folder.children || [], validFolderIds);

            if (validFolderIds.has(folder.id) || filteredChildren.length > 0) {
                acc.push({
                    ...folder,
                    children: filteredChildren,
                });
            }
            return acc;
        }, []);
    }

    _getFolderSubtreeIds(folderId) {
        const result = new Set([folderId]);
        if (!folderId || !this.folderTree?.length) return result;

        const search = [...this.folderTree];
        let root = null;
        while (search.length) {
            const node = search.pop();
            if (!node) continue;
            if (node.id === folderId) {
                root = node;
                break;
            }
            if (Array.isArray(node.children) && node.children.length) {
                search.push(...node.children);
            }
        }

        if (!root) return result;

        const stack = [root];
        while (stack.length) {
            const node = stack.pop();
            if (!node) continue;
            result.add(node.id);
            if (Array.isArray(node.children) && node.children.length) {
                stack.push(...node.children);
            }
        }
        return result;
    }

    _isFolderNodeOpen(folderId) {
        if (this._folderNodeOpenState.has(folderId)) {
            return this._folderNodeOpenState.get(folderId) === true;
        }
        return false;
    }

    _decorateFolderTree(folders) {
        if (!Array.isArray(folders)) return [];
        return folders.map((folder) => {
            const children = this._decorateFolderTree(folder.children || []);
            const hasChildren = children.length > 0;
            return {
                ...folder,
                children,
                hasChildren,
                expanded: hasChildren ? this._isFolderNodeOpen(folder.id) : false,
            };
        });
    }

    _toggleFolderNode(folderId) {
        if (!folderId) return;
        const next = !this._isFolderNodeOpen(folderId);
        this._folderNodeOpenState.set(folderId, next);
    }

    static #onSwitchTab(event, target) {
        const tab = target.dataset.tab;
        if (tab && tab !== this.activeTab) {
            this._resetBulkSelection({ disableMode: true });
            this.activeTab = tab;
            this._setLastOpenPreference(this.mode, this.activeTab);
            this.activeFolderId = null;
            this._resetBatching();
            if (tab === "Item") {
                this.activeCategoryGroup = "Character";
            } else {
                this.activeCategoryGroup = "All";
            }

            for (const filter of this.filters) {
                for (const value of filter.values) {
                    value.state = "off";
                }
            }
            this.showDuplicates = false;
            this.wrappedOnResetFilters();
            this.render();
        }
    }

    static #onToggleCategoryBar(event, target) {}

    static #onSelectCategoryGroup(event, target) {
        const group = target.dataset.group;
        if (group && group !== this.activeCategoryGroup) {
            this.activeCategoryGroup = group;
            this._resetBatching();
            this.wrappedOnResetFilters();
            
            this.render();
        }
    }

    static async #onOpenCategoryConfig(event, target) {
        const app = new CategoryConfigApp();
        app.render(true);
        const hookId = Hooks.on("closeApplication", (closedApp) => {
            if (closedApp === app) {
                Hooks.off("closeApplication", hookId);
                this.render();
            }
        });
    }
    static async #onOpenTagGroupConfig(event, target) {
        const app = new TagGroupConfigApp();
        app.render(true);
        const hookId = Hooks.on("closeApplication", (closedApp) => {
            if (closedApp === app) {
                Hooks.off("closeApplication", hookId);
                this.render();
            }
        });
    }

    static #onToggleBulkSelectMode(event, target) {
        if (!supportsFlagTagsForTab(this.activeTab) || !game.user.isGM) return;
        this.bulkSelectMode = !this.bulkSelectMode;
        if (!this.bulkSelectMode) this._resetBulkSelection();
        this.render();
    }

    static #onClearBulkSelection(event, target) {
        this._resetBulkSelection();
        this.render();
    }

    static async #onApplyBulkEditSelected(event, target) {
        const selected = this._getSelectedAssetsForBulkEdit();
        const sourceAssets = selected.length ? selected : this.filteredAssets;
        if (!sourceAssets.length) {
            ui.notifications.warn(game.i18n.localize("ASSET_LIBRARIAN.Tagging.BulkNoSelected"));
            return;
        }
        await this._openBulkTagEditorForAssets(this.activeTab, sourceAssets);
    }
    static #onToggleMode(event, target) {
        this._resetBulkSelection({ disableMode: true });
        this.mode = this.mode === "world" ? "compendium" : "world";
        this._setLastOpenPreference(this.mode, this.activeTab);
        this.activeFolderId = null;
        this._resetBatching();
        this.wrappedOnResetFilters();
        this.render();
    }

    static #onToggleDuplicates(event, target) {
        this.showDuplicates = !this.showDuplicates;
        this._resetBatching();
        this.render();
    }
    static #onToggleFolderNode(event, target) {
        event.preventDefault();
        event.stopPropagation();
        const folderId = target.dataset.folderId;
        if (!folderId) return;
        this._toggleFolderNode(folderId);
        this.render();
    }
    static #onSelectFolder(event, target) {
        const folderId = target.dataset.folderId;

        if (this.activeFolderId === folderId) {
            this.activeFolderId = null;
        } else {
            this.activeFolderId = folderId;
        }

        this.element.querySelectorAll(".folder-item").forEach((el) => el.classList.remove("active"));
        if (this.activeFolderId) {
            target.classList.add("active");
        }

        this._resetBatching();
        this._scheduleMainRender(0, { recompute: true });

    }

    static async #onDeleteAsset(event, target) {
        const uuid = target.dataset.uuid;
        const asset = this.filteredAssets.find((a) => a.uuid === uuid);
        if (!asset) return;

        if (this.mode === "world" && this.activeTab === "Actor") {
            const usage = DataManager.findUsage(asset.id);
            if (usage.length > 0) {
                const confirm = await helpers.confirmationDialog(
                    `<p>This actor is used in the following scenes:</p><ul>${usage.map((s) => `<li>${s}</li>`).join("")}</ul><p>Are you sure you want to delete it?</p>`,
                );
                if (!confirm) return;
            }
        }

        const doc = await fromUuid(uuid);
        if (doc) {
            await doc.delete();
            this.invalidateDataCache({ mode: this.mode, tab: this.activeTab });
            ui.notifications.info(game.i18n.format("ASSET_LIBRARIAN.Notifications.AssetDeleted", { name: asset.name }));
            this.render();
        }
    }

    static async #onOpenSettings(event, target) {
        const app = new CompendiumSelectorApp();
        app.render(true);
        const hookId = Hooks.on("closeApplication", (closedApp) => {
            if (closedApp === app) {
                Hooks.off("closeApplication", hookId);
                DataManager.invalidateCompendiumCache();
                this.invalidateDataCache({ mode: "compendium" });
                if (this.mode === "compendium") {
                    this.render();
                }
            }
        });
    }

    static #onToggleFilter(event, target) {
        event.preventDefault();
        const filterKey = target.dataset.filterKey;
        const filterValue = target.dataset.filterValue;
        const isRightClick = event.type === "contextmenu" || event.button === 2;

        const filter = this.filters.find((f) => f.key === filterKey);
        if (filter) {
            const valueObj = filter.values.find((v) => v.value === filterValue);
            if (valueObj) {
                if (isRightClick) {
                    valueObj.state = valueObj.state === "off" ? "exclude" : "off";
                } else {
                    if (valueObj.state === "off") valueObj.state = "include";      // OR
                    else if (valueObj.state === "include") valueObj.state = "and"; // AND
                    else if (valueObj.state === "and") valueObj.state = "off";     // Deselect
                    else if (valueObj.state === "exclude") valueObj.state = "include";
                    else valueObj.state = "off";                }
            }
        }

        this._scheduleMainRender(50, { recompute: true });

    }

    _updateAssetVisibility() {
        const validUuids = new Set(this.filteredAssets.map((a) => a.uuid));

        const grid = this.element.querySelector(".asset-grid");
        if (!grid) return;

        let visibleCount = 0;

        const items = this.#filterableItems;

        for (const item of items) {
            const inFilterSet = validUuids.has(item.uuid || item.element.dataset.uuid);
            const isVisible = inFilterSet;
            item.element.style.display = isVisible ? "" : "none";
            if (isVisible) visibleCount++;
        }

        const countSpan = this.element.querySelector(".asset-count");
        if (countSpan) {
            const displayCount = this.searchQuery ? visibleCount : this.filteredAssets.length;
            countSpan.textContent = game.i18n.format("ASSET_LIBRARIAN.Counts.Showing", {
                visible: displayCount,
                total: this.allAssets.length,
            });
        }
    }

    _updateFilterSidebar() {
        const sidebar = this.element.querySelector(".filter-panel-content");
        if (!sidebar) return;

        const availableFilters = new Map();
        for (const group of this.filters) {
            if (!availableFilters.has(group.key)) {
                availableFilters.set(group.key, new Map());
            }
            const valueMap = availableFilters.get(group.key);
            for (const val of group.values) {
                valueMap.set(val.value.toString(), val);
            }
        }

        const allTags = sidebar.querySelectorAll(".filter-tag");
        for (const btn of allTags) {
            const key = btn.dataset.filterKey;
            const value = btn.dataset.filterValue;

            const groupMap = availableFilters.get(key);
            const filterData = groupMap?.get(value);

            if (filterData) {
                btn.style.display = "";

                btn.classList.remove("state-off", "state-include", "state-and", "state-exclude");
                btn.classList.add(`state-${filterData.state}`);

                const iconHtml =
                    filterData.state === "exclude"
                        ? '<i class="fas fa-ban"></i> '
                        : filterData.state === "and"
                            ? '<i class="fas fa-link"></i> '
                            : "";
            btn.innerHTML = `${iconHtml}<span class="al-filter-label">${filterData.label}</span> <span class="filter-count">(${filterData.count})</span>`;
            } else {
                btn.style.display = "none";
            }
        }

        const groups = sidebar.querySelectorAll(".filter-group");
        for (const groupDiv of groups) {
            const visibleTags = groupDiv.querySelectorAll(".filter-tag:not([style*='display: none'])");
            groupDiv.style.display = visibleTags.length > 0 ? "" : "none";
        }
    }

    static async #onRefreshImages(event, target) {
        if (this.activeTab !== "Image") return;

        this.isScanning = true;
        this.render();
        this._imageLoadToken += 1;
        ImageScanner.invalidateImageCache();
        const images = await ImageScanner.startBackgroundScan({ force: true });
        this.allAssets = Array.isArray(images) ? images : [];
        this._pruneThumbnailManifestForCurrentImages(this.allAssets, { force: true });
        this.folderTree = ImageScanner.buildFolderTree(this.allAssets);
        this.invalidateDataCache({ mode: this.mode, tab: this.activeTab });
        this._thumbnailJobTokens.delete(`${this.mode}:Image`);
        this._dataCache.set(this._getDataCacheKey(), {
            assets: this.allAssets,
            folderTree: this.folderTree,
        });
        this.isScanning = false;

        this._applyFilters();
        this._startThumbnailHydration([...this.renderedAssets], "Image", this.mode, { prune: true });
        this.render();
        setTimeout(() => {
            if (this.mode !== "world" || this.activeTab !== "Image") return;
            this._scheduleRenderedThumbnailHydration();
        }, 60);
        const scanMeta = ImageScanner.getLastScanMeta();
        const counts = scanMeta?.counts;
        const baseMessage = game.i18n.format("ASSET_LIBRARIAN.Notifications.ImagesFound", {
            count: this.allAssets.length,
        });
        if (counts) {
            ui.notifications.info(`${baseMessage} (+${counts.added} -${counts.removed} ~${counts.changed})`);
        } else {
            ui.notifications.info(baseMessage);
        }
    }

    static async #onConfigureImages(event, target) {
        const changed = await openImagePathsDialog();
        if (changed === true && this.activeTab === "Image") {
            await AssetLibrarian.#onRefreshImages.call(this, event, target);
        }
    }

    _getScenePreviewCacheKey(scene) {
        const tileSignature = Array.from(scene?.tiles || [])
            .filter((tile) => tile?.texture?.src && !tile.hidden)
            .map((tile) =>
                [
                    tile.texture.src,
                    Number(tile.x) || 0,
                    Number(tile.y) || 0,
                    Number(tile.width) || 0,
                    Number(tile.height) || 0,
                    Number(tile.rotation) || 0,
                    Number(tile.elevation) || 0,
                    Number(tile.sort) || 0,
                    Number(tile.texture?.scaleX ?? 1),
                    Number(tile.texture?.scaleY ?? 1),
                    Number(tile.texture?.tint ?? 0xffffff),
                ].join(","),
            )
            .join(";");
        return [
            "scene-preview",
            scene?.uuid || scene?.id || "",
            scene?.background?.src || "",
            scene?.foreground || "",
            Number(scene?.width) || 0,
            Number(scene?.height) || 0,
            `max=${SCENE_PREVIEW_MAX_DIMENSION}`,
            `q=${SCENE_PREVIEW_QUALITY}`,
            tileSignature,
        ].join("|");
    }

    _cacheScenePreview(cacheKey, value) {
        if (!cacheKey || !value) return;
        if (this._scenePreviewCache.has(cacheKey)) this._scenePreviewCache.delete(cacheKey);
        this._scenePreviewCache.set(cacheKey, value);
        this._pruneScenePreviewMemoryCache();
    }

    _pruneScenePreviewMemoryCache() {
        const limit = this._getThumbnailMemoryCacheLimit();
        if (limit === 0) return;
        while (this._scenePreviewCache.size > limit) {
            const oldest = this._scenePreviewCache.keys().next().value;
            this._scenePreviewCache.delete(oldest);
        }
    }

    async _createScenePreview(scene) {
        if (!scene) return null;

        const backgroundSrc = scene.background?.src || "";
        const foregroundSrc = scene.foreground || "";
        const tiles = Array.from(scene.tiles || []).filter((tile) => tile?.texture?.src && !tile.hidden);
        const toLoad = [
            backgroundSrc,
            foregroundSrc,
            ...tiles.map((tile) => tile.texture.src),
        ].filter(Boolean);

        if (toLoad.length) {
            await foundry.canvas.TextureLoader.loader.load(toLoad);
        }

        const backgroundTexture = backgroundSrc ? foundry.canvas.getTexture(backgroundSrc) : null;
        const foregroundTexture = foregroundSrc ? foundry.canvas.getTexture(foregroundSrc) : null;

        const fallbackSceneWidth = Number(scene.width) || backgroundTexture?.width || foregroundTexture?.width || 0;
        const fallbackSceneHeight = Number(scene.height) || backgroundTexture?.height || foregroundTexture?.height || 0;
        if (fallbackSceneWidth <= 0 || fallbackSceneHeight <= 0) return null;

        const dimensions = typeof scene.getDimensions === "function" ? scene.getDimensions() : null;
        const renderSceneWidth = Number(dimensions?.sceneWidth) || fallbackSceneWidth;
        const renderSceneHeight = Number(dimensions?.sceneHeight) || fallbackSceneHeight;
        const sceneRectX = Number(dimensions?.sceneRect?.x) || 0;
        const sceneRectY = Number(dimensions?.sceneRect?.y) || 0;

        const scale = Math.min(1, SCENE_PREVIEW_MAX_DIMENSION / renderSceneWidth, SCENE_PREVIEW_MAX_DIMENSION / renderSceneHeight);
        const previewWidth = Math.max(1, Math.round(renderSceneWidth * scale));
        const previewHeight = Math.max(1, Math.round(renderSceneHeight * scale));

        const stage = new PIXI.Container();
        const baseContainer = new PIXI.Container();
        stage.addChild(baseContainer);

        const GraphicsClass = PIXI.LegacyGraphics || PIXI.Graphics;
        const maskGraphic = new GraphicsClass();
        maskGraphic.beginFill(0xffffff, 1.0).drawRect(0, 0, renderSceneWidth, renderSceneHeight).endFill();
        maskGraphic.elevation = -Infinity;
        maskGraphic.zIndex = -Infinity;
        baseContainer.addChild(maskGraphic);
        baseContainer.mask = maskGraphic;

        if (backgroundTexture) {
            const bg = new PIXI.Sprite(backgroundTexture);
            bg.width = renderSceneWidth;
            bg.height = renderSceneHeight;
            bg.elevation = foundry.canvas.groups.PrimaryCanvasGroup?.BACKGROUND_ELEVATION ?? -Infinity;
            bg.zIndex = -Infinity;
            baseContainer.addChild(bg);
        }

        if (foregroundTexture) {
            const fg = new PIXI.Sprite(foregroundTexture);
            fg.width = renderSceneWidth;
            fg.height = renderSceneHeight;
            fg.elevation = Number(scene.foregroundElevation) || 0;
            fg.zIndex = -Infinity;
            baseContainer.addChild(fg);
        }

        for (const tile of tiles) {
            const tileTexture = foundry.canvas.getTexture(tile.texture.src);
            if (!tileTexture) continue;
            const sprite = new PIXI.Sprite(tileTexture);
            const width = Number(tile.width) || tileTexture.width || 0;
            const height = Number(tile.height) || tileTexture.height || 0;
            const x = Number(tile.x) || 0;
            const y = Number(tile.y) || 0;
            const rotation = Number(tile.rotation) || 0;
            const scaleX = Number(tile.texture?.scaleX ?? 1);
            const scaleY = Number(tile.texture?.scaleY ?? 1);
            const tint = Number(tile.texture?.tint ?? 0xffffff);

            sprite.anchor.set(0.5, 0.5);
            sprite.width = Math.abs(width);
            sprite.height = Math.abs(height);
            sprite.scale.x *= scaleX;
            sprite.scale.y *= scaleY;
            sprite.tint = tint;
            sprite.position.set(x + width / 2 - sceneRectX, y + height / 2 - sceneRectY);
            sprite.angle = rotation;
            sprite.elevation = Number(tile.elevation) || 0;
            sprite.zIndex = Number(tile.sort) || 0;
            baseContainer.addChild(sprite);
        }

        baseContainer.children.sort((a, b) => (Number(a.elevation) - Number(b.elevation)) || (Number(a.zIndex) - Number(b.zIndex)));

        const thumbResult = await foundry.helpers.media.ImageHelper.createThumbnail(stage, {
            width: previewWidth,
            height: previewHeight,
            format: "image/webp",
            quality: SCENE_PREVIEW_QUALITY,
        });
        return thumbResult?.thumb || null;
    }

    async _getScenePreviewImage(scene) {
        if (!scene) return null;
        const cacheKey = this._getScenePreviewCacheKey(scene);
        const cached = this._scenePreviewCache.get(cacheKey);
        if (cached) {
            const cachedAvailable = await this._isImagePathAvailable(cached);
            if (cachedAvailable) {
                this._scenePreviewCache.delete(cacheKey);
                this._scenePreviewCache.set(cacheKey, cached);
                return cached;
            }
            this._scenePreviewCache.delete(cacheKey);
            const map = this._getScenePreviewDiskMap();
            if (map[cacheKey] && (this._normalizeFilePickerPath(map[cacheKey]) === this._normalizeFilePickerPath(cached))) {
                delete map[cacheKey];
                this._scheduleScenePreviewMapFlush();
            }
        }
        const diskThumb = this._getScenePreviewDiskMap()?.[cacheKey];
        if (diskThumb) {
            const available = await this._isImagePathAvailable(diskThumb);
            if (!available) {
                const map = this._getScenePreviewDiskMap();
                delete map[cacheKey];
                this._scheduleScenePreviewMapFlush();
            } else {
                this._cacheScenePreview(cacheKey, diskThumb);
                return diskThumb;
            }
        }

        if (this._scenePreviewPromises.has(cacheKey)) {
            return this._scenePreviewPromises.get(cacheKey);
        }

        const promise = (async () => {
            try {
                const previewDataUrl = await this._createScenePreview(scene);
                if (!previewDataUrl) return null;
                let preview = previewDataUrl;
                const stored = await this._persistScenePreviewToDisk(cacheKey, previewDataUrl);
                if (stored) preview = stored;
                this._cacheScenePreview(cacheKey, preview);
                return preview;
            } catch (_err) {
                return null;
            } finally {
                this._scenePreviewPromises.delete(cacheKey);
            }
        })();

        this._scenePreviewPromises.set(cacheKey, promise);
        return promise;
    }

    async _popOutImage(asset, type = "image") {
        let img;
        if (type === "scene") {
            img = (await this._getScenePreviewImage(asset)) || asset.background?.src || asset.foreground;
            if (!img) return ui.notifications.info("No scene background or foreground image set");
        } else {
            img = asset.img;
        }
        const ip = new foundry.applications.apps.ImagePopout({
            src: img,
            window: { title: asset.name },
        });
        ip.render({ force: true });
    }

    static async #onViewAsset(event, target) {
        const uuid = target.closest("[data-uuid]")?.dataset.uuid;
        if (!uuid) return;
        if (this.bulkSelectMode && supportsFlagTagsForTab(this.activeTab)) {
            if (!this._canEditTagsForEntry(uuid, this.activeTab)) {
                ui.notifications.warn(game.i18n.localize("ASSET_LIBRARIAN.Tagging.NoPermission"));
                return;
            }
            if (this.selectedAssetUuids.has(uuid)) this.selectedAssetUuids.delete(uuid);
            else this.selectedAssetUuids.add(uuid);
            this.render({ parts: ["main"] });
            return;
        }

        if (this.activeTab === "Image") {
            const asset = this.filteredAssets.find((a) => a.uuid === uuid);
            if (asset) {
                await this._popOutImage(asset);
            }
        } else if (this.activeTab === "Scene") {
            if (this.mode === "compendium") {
                const compendiumScene = await fromUuid(uuid);
                await this._popOutImage(compendiumScene, "scene");
            } else {
                game.scenes.get(foundry.utils.parseUuid(uuid).id)?.view();
            }
        } else {
            const doc = await fromUuid(uuid);
            if (doc?.sheet) {
                doc.sheet.render(true);
            }
        }
    }

    static #onToggleFilterPanel(event, target) {
        const collapsed = this._toggleFilterPanel();
        game.user.setFlag("asset-librarian", "filterPanelOpen", collapsed);
    }

    static #onToggleFolderPanel(event, target) {
        const collapsed = this._toggleFolderPanel();
        game.user.setFlag("asset-librarian", "folderPanelOpen", collapsed);
    }
    /**
     * Toggle the sidebar collapsed state.
     * @param {boolean} [collapsed]  Force a particular collapsed state.
     * @returns {boolean}            The new collapsed state.
     * @protected
     */
    _toggleFilterPanel(collapsed) {
        this.element.querySelector(".asset-librarian-container").classList.toggle("filter-panel-collapsed", collapsed);
        const isCollapsed = this.element
            .querySelector(".asset-librarian-container")
            .classList.contains("filter-panel-collapsed");
        const icon = this.element.querySelector(".filter-panel-collapser i");
        if (icon) {
            icon.classList.remove("fa-caret-left", "fa-caret-right");
            icon.classList.add(`fa-caret-${isCollapsed ? "left" : "right"}`);
        }
        return isCollapsed;
    }

    /**
     * Toggle the sidebar collapsed state.
     * @param {boolean} [collapsed]  Force a particular collapsed state.
     * @returns {boolean}            The new collapsed state.
     * @protected
     */
    _toggleFolderPanel(collapsed) {
        this.element.querySelector(".asset-librarian-container").classList.toggle("folder-panel-collapsed", collapsed);
        const isCollapsed = this.element
            .querySelector(".asset-librarian-container")
            .classList.contains("folder-panel-collapsed");
        const icon = this.element.querySelector(".folder-panel-collapser i");
        if (icon) {
            icon.classList.remove("fa-caret-left", "fa-caret-right");
            icon.classList.add(`fa-caret-${isCollapsed ? "right" : "left"}`);
        }
        return isCollapsed;
    }

    static #onChangeViewMode(event, target) {
        const mode = target.dataset.mode;
        if (mode && ["list", "column-list", "small", "medium", "large"].includes(mode)) {
            this.viewMode = mode;
            game.settings.set("asset-librarian", "viewMode", mode);
            this.render();
        }
    }

    static async #onConfigureFilters(event, target) {
        const app = new CustomFilterFieldsApp();
        app.render(true);

        const hookId = Hooks.on("closeApplication", (closedApp) => {
            if (closedApp === app) {
                Hooks.off("closeApplication", hookId);
                DataManager.invalidateCache();
                this.invalidateDataCache();
                this._applyFilters();
                this.render();
            }
        });
    }

    wrappedOnResetFilters() {
        for (const filter of this.filters) {
            for (const value of filter.values) {
                value.state = "off";
            }
        }
        
        this._lastComputedFilterStateKey = null;
    }

    static #onResetFilters(event, target) {
        this.wrappedOnResetFilters();
        this.render();
    }
}
