import { FilterManager } from "./filter-manager.js";
import { ASSET_LIBRARIAN_BASE_TABS, helpers } from "./helpers.js";
import { CATEGORY_TAG_PATH, FILTER_TAG_PATH } from "./asset-tags.js";

export class DataManager {
    static _fieldDefsCache = new Map();
    static _fieldsToSyncCache = new Map();
    static _compendiumAssetsCache = new Map();

    static DEFAULT_IMAGES = {
        Actor: "icons/svg/mystery-man.svg",
        Item: "icons/svg/item-bag.svg",
        JournalEntry: "icons/svg/book.svg",
        Scene: "icons/svg/city.svg",
        RollTable:"icons/svg/d20.svg",
        Playlist:"icons/svg/sound.svg",
        Macro:"icons/svg/dice-target.svg",
        Cards:"icons/svg/card-hand.svg",
    };

    static invalidateCache() {
        this._fieldDefsCache.clear();
        this._fieldsToSyncCache.clear();
        this._compendiumAssetsCache.clear();
    }

    static invalidateCompendiumCache(packCode) {
        if (packCode) {
            this._compendiumAssetsCache.delete(packCode);
        } else {
            this._compendiumAssetsCache.clear();
        }
    }
    
    static updateCompendiumCachedAssetTags(uuid, { categoryTag = "", filterTag = [] } = {}) {
        if (typeof uuid !== "string" || !uuid.startsWith("Compendium.")) return;
        const parts = uuid.split(".");
        if (parts.length < 4) return;
        const packCollection = `${parts[1]}.${parts[2]}`;
        const cachedAssets = this._compendiumAssetsCache.get(packCollection);
        if (!Array.isArray(cachedAssets) || !cachedAssets.length) return;

        const target = cachedAssets.find((a) => a?.uuid === uuid);
        if (!target) return;
        target.flags ??= {};
        target.flags["asset-librarian"] ??= {};

        if (categoryTag) target.flags["asset-librarian"].categoryTag = categoryTag;
        else delete target.flags["asset-librarian"].categoryTag;

        if (Array.isArray(filterTag) && filterTag.length) target.flags["asset-librarian"].filterTag = filterTag;
        else delete target.flags["asset-librarian"].filterTag;
    }

    static async cacheAll() {
        console.log("Asset Librarian | Warming up compendium cache...");
        const types = [...ASSET_LIBRARIAN_BASE_TABS];
        for (const type of types) {
            await this._getCompendiumAssets(type);
        }
        console.log("Asset Librarian | Compendium cache scan complete.");
    }

    /**
     * Get a flat list of assets for the grid view.
     * @param {string} type - 'Actor', 'Item', 'JournalEntry', 'Scene'
     * @param {boolean} isWorld - Whether to scan the world or compendiums
     * @returns {Promise<Array>}
     */
    static async getAssets(type, isWorld) {
        if (isWorld) {
            return this._getWorldAssets(type);
        } else {
            return this._getCompendiumAssets(type);
        }
    }

    /**
     * Get the hierarchical folder tree for the sidebar.
     * @param {string} type 
     * @param {boolean} isWorld 
     * @returns {Promise<Array>}
     */
    static async getFolderTree(type, isWorld) {
        if (isWorld) {
            return this._getWorldFolderTree(type);
        } else {
            return this._getCompendiumFolderTree(type);
        }
    }

    static async _runWithConcurrency(items, limit, worker) {
        const queue = Array.isArray(items) ? items : [];
        if (!queue.length) return;
        const max = Math.max(1, Number(limit) || 1);
        let cursor = 0;
        const workers = Array.from({ length: Math.min(max, queue.length) }, () =>
            (async () => {
                while (cursor < queue.length) {
                    const index = cursor++;
                    const item = queue[index];
                    if (item === undefined) continue;
                    await worker(item, index);
                }
            })()
        );
        await Promise.all(workers);
    }

    static async _resolveLinkedActorImage(linkedActorUuid, cache) {
        if (!linkedActorUuid || typeof linkedActorUuid !== "string") return "";
        if (cache?.has(linkedActorUuid)) return cache.get(linkedActorUuid);

        const resolver = (async () => {
            try {
                if (linkedActorUuid.startsWith("Actor.")) {
                    const [, actorId] = linkedActorUuid.split(".");
                    return game.actors.get(actorId)?.img || "";
                }
                const linkedActor = await fromUuid(linkedActorUuid);
                return linkedActor?.img || "";
            } catch (_err) {
                return "";
            }
        })();

        cache?.set(linkedActorUuid, resolver);
        return resolver;
    }

    static async _getWorldAssets(type) {
        const collection = game.collections.get(type);
        if (!collection) return [];

        if (!this._fieldDefsCache.has(type)) {
            this._fieldDefsCache.set(type, FilterManager.getFieldDefinitions(type));
        }
        const fieldDefs = this._fieldDefsCache.get(type);

        if (!this._fieldsToSyncCache.has(type)) {
            this._fieldsToSyncCache.set(type, fieldDefs);
        }

        const fieldsToSync = this._fieldsToSyncCache.get(type);


        const OBSERVER = foundry.CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER;
        const isGM = game.user.isGM;

        
        const isDND5e = game.system.id === "dnd5e";
        const spellListMap = new Map();

        if (isDND5e && type === "Item" && game.dnd5e.registry?.spellLists?.options) {
            const options = game.dnd5e.registry.spellLists.options;
            for (const option of options) {
                try {
                    const list = game.dnd5e.registry.spellLists.forType(option.type, option.value);
                    if (list && list.uuids) {
                        for (const uuid of list.uuids) {
                            if (!spellListMap.has(uuid)) spellListMap.set(uuid, []);
                            spellListMap.get(uuid).push(option.label);
                        }
                    }
                } catch (e) {
                    
                }
            }
        }

        const linkedActorImageTasks = [];
        const linkedActorImageCache = new Map();
        const assets = [];
        for (const doc of collection.contents) {
            if (!isGM && !doc.testUserPermission(game.user, OBSERVER)) continue;

            const codexImage = foundry.utils.getProperty(doc, "flags.campaign-codex.image");
            const linkedActorUuid = foundry.utils.getProperty(doc, "flags.campaign-codex.data.linkedActor");

            const asset = {
                id: doc.id,
                name: doc.name,
                img: codexImage || doc.img || doc.thumb || this._getDefaultImage(type),
                folder: doc.folder?.id || null,
                uuid: doc.uuid,
                type: doc.type,
                sort: doc.sort,
                system: doc.system,
                flags: doc.flags,
                navigation: doc.navigation,
                active: doc.active,
                _hasPages: doc.pages?.size > 0 ? 'Yes' : 'No',
                _sheetClass: doc._getSheetClass?.()?.name || doc.sheet?.constructor?.name || 'Default',
            };

            if (isDND5e && doc.type === "spell" && spellListMap.has(doc.uuid)) {
                asset.spellList = spellListMap.get(doc.uuid);
            }

            for (const field of fieldsToSync) {
                if (foundry.utils.hasProperty(asset, field.path)) continue;
                const val = FilterManager.getNestedValue(doc, field._parsedPath);
                if (val !== undefined) {
                    foundry.utils.setProperty(asset, field.path, val);
                }
            }

            if (
                type === "JournalEntry" &&
                linkedActorUuid &&
                !codexImage &&
                !doc.img &&
                !doc.thumb
            ) {
                linkedActorImageTasks.push({ asset, linkedActorUuid });
            }

            assets.push(asset);
        }

        await this._runWithConcurrency(linkedActorImageTasks, 8, async ({ asset, linkedActorUuid }) => {
            const linkedImage = await this._resolveLinkedActorImage(linkedActorUuid, linkedActorImageCache);
            if (linkedImage) asset.img = linkedImage;
        });

        return assets.sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
        
        // return assets.sort((a, b) => a.sort - b.sort);
    }

    static async _getCompendiumAssets(type) {
        const settings = game.settings.get("asset-librarian", "includedCompendiums") || {};
        const packs = game.packs.filter(p => p.documentName === type && settings[p.collection]);

        if (!this._fieldDefsCache.has(type)) {
            this._fieldDefsCache.set(type, FilterManager.getFieldDefinitions(type));
        }
        const fieldDefs = this._fieldDefsCache.get(type);

        if (!this._fieldsToSyncCache.has(type)) {
            this._fieldsToSyncCache.set(type, fieldDefs);
        }

        const fieldsToSync = this._fieldsToSyncCache.get(type);
        const indexFields = ["img", "folder", "type", "thumb", "flags", CATEGORY_TAG_PATH, FILTER_TAG_PATH];

        const extraFieldsSet = new Set([
            ...indexFields,
            ...fieldDefs.map(f => f._parsedPath?.[0]).filter(Boolean)
        ]);

        const OBSERVER = foundry.CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER;
        const isGM = game.user.isGM;

        
        const isDND5e = game.system.id === "dnd5e";
        const spellListMap = new Map();

        if (isDND5e && type === "Item" && game.dnd5e.registry?.spellLists?.options) {
            const options = game.dnd5e.registry.spellLists.options;
            for (const option of options) {
                try {
                    const list = game.dnd5e.registry.spellLists.forType(option.value);
                    if (list && list.uuids) {
                        for (const uuid of list.uuids) {
                            if (!spellListMap.has(uuid)) spellListMap.set(uuid, []);
                            spellListMap.get(uuid).push(option.label);
                        }
                    }
                } catch (e) {
                }
            }
        }

        const results = await Promise.all(packs.map(async (pack) => {
            
            if (this._compendiumAssetsCache.has(pack.collection)) {
                return this._compendiumAssetsCache.get(pack.collection);
            }

            if (!isGM && !pack.testUserPermission(game.user, OBSERVER)) return [];

            try {
                const index = await pack.getIndex({ fields: extraFieldsSet });
                const packSource = this._getPackSourceInfo(pack);
                const linkedActorImageTasks = [];
                const linkedActorImageCache = new Map();
                const assets = index.map((entry) => {
                    const folderId = entry.folder ? this._toPackFolderId(pack.collection, entry.folder) : null;
                    const codexImage = foundry.utils.getProperty(entry, "flags.campaign-codex.image");
                    const linkedActorUuid = foundry.utils.getProperty(entry, "flags.campaign-codex.data.linkedActor");

                    const asset = {
                        id: entry._id,
                        name: entry.name,
                        img: codexImage || entry.img || entry.thumb || this._getDefaultImage(type),
                        folder: folderId,
                        uuid: entry.uuid,
                        type: entry.type,
                        packSource: packSource.id,
                        pack: pack.collection,
                        collectionName: pack.title,
                        flags: entry.flags,
                        _sheetClass: entry._sheetClass,
                        system: entry.system
                    };

                    if (
                        type === "JournalEntry" &&
                        linkedActorUuid &&
                        !codexImage &&
                        !entry.img &&
                        !entry.thumb
                    ) {
                        linkedActorImageTasks.push({ asset, linkedActorUuid });
                    }

                    if (isDND5e && entry.type === "spell" && spellListMap.has(entry.uuid)) {
                        asset.spellList = spellListMap.get(entry.uuid);
                    }

                    for (const field of fieldsToSync) {
                        if (foundry.utils.hasProperty(asset, field.path)) continue;
                        const val = FilterManager.getNestedValue(entry, field._parsedPath);
                        if (val !== undefined) {
                            foundry.utils.setProperty(asset, field.path, val);
                        }
                    }
                    return asset;
                });

                await this._runWithConcurrency(linkedActorImageTasks, 8, async ({ asset, linkedActorUuid }) => {
                    const linkedImage = await this._resolveLinkedActorImage(linkedActorUuid, linkedActorImageCache);
                    if (linkedImage) asset.img = linkedImage;
                });

                
                this._compendiumAssetsCache.set(pack.collection, assets);
                return assets;

            } catch (err) {
                console.warn(`Asset Librarian | Failed to index pack ${pack.collection}:`, err);
                return [];
            }
        }));

        const flatResults = results.flat();
        const sortedResults = flatResults.sort((a, b) =>
            a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" })
        );
        return sortedResults;
    }

    static _getDefaultImage(type) {
        return this.DEFAULT_IMAGES[type] || "icons/svg/mystery-man.svg";
    }

    static _getWorldFolderTree(type) {
        
        const folders = game.folders.filter(f => f.type === type).map(f => ({
            id: f.id,
            name: f.name,
            parent: f.folder?.id || null,
            depth: f.depth || 0,
            sort: f.sort || 0
        }));

        return this._buildTree(folders);
    }

    /**
     * Convert flat folder list to nested tree, sorted by sort/name.
     * @param {Array} folders Flat list of folders
     * @returns {Array} Nested tree
     */
    static _buildTree(folders) {
        const folderMap = {};
        const roots = [];

        
        for (const folder of folders) {
            folder.children = [];
            folderMap[folder.id] = folder;
        }

        
        for (const folder of folders) {
            if (folder.parent && folderMap[folder.parent]) {
                folderMap[folder.parent].children.push(folder);
            } else {
                roots.push(folder);
            }
        }

        
        const sortFolders = (list) => {
            list.sort((a, b) => {
                if (a.sort !== b.sort) return a.sort - b.sort;
                return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
            });
            for (const folder of list) {
                if (folder.children.length > 0) {
                    sortFolders(folder.children);
                }
            }
        };

        sortFolders(roots);
        return roots;
    }

    static async _getCompendiumFolderTree(type) {
        const settings = game.settings.get("asset-librarian", "includedCompendiums") || {};
        const OBSERVER = foundry.CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER;

        const packs = game.packs.filter(p =>
            p.documentName === type &&
            settings[p.collection] &&
            p.testUserPermission(game.user, OBSERVER)
        );

        
        packs.sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: "base" }));

        const grouped = new Map();
        for (const pack of packs) {
            const source = this._getPackSourceInfo(pack);
            if (!grouped.has(source.id)) {
                grouped.set(source.id, {
                    id: source.id,
                    name: source.label,
                    parent: null,
                    depth: 1,
                    children: [],
                    sort: source.label,
                });
            }
            const packChildren = this._getCompendiumPackFolderTree(pack);
            grouped.get(source.id).children.push({
                id: pack.collection,
                name: this._getPackDisplayLabel(pack),
                isPack: true,
                parent: source.id,
                depth: 2,
                children: [],
                children: packChildren,
                sort: this._getPackDisplayLabel(pack),
            });
        }

        const roots = Array.from(grouped.values()).sort((a, b) =>
            a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" })
        );
        for (const root of roots) {
            root.children.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
        }
        return roots;
    }
    static _toPackFolderId(packCollection, folderId) {
        return `${packCollection}::${folderId}`;
    }

    static _getCompendiumPackFolderTree(pack) {
        const rawFolders = Array.from(pack?.folders || []);
        if (!rawFolders.length) return [];

        const flatFolders = rawFolders.map((folder) => ({
            id: this._toPackFolderId(pack.collection, folder.id),
            name: folder.name,
            parent: folder.folder?.id ? this._toPackFolderId(pack.collection, folder.folder.id) : null,
            depth: 3,
            sort: 0,
            // sort: folder.sort || 0,
            isPack: false,
        }));

        return this._buildTree(flatFolders);
    }
    static _getPackSourceInfo(pack) {
        const sourceId = String(pack?.collection || "").split(".")[0] || "unknown";
        if (sourceId === game.world?.id) {
            return { id: `source:${sourceId}`, label: game.world?.title || "World" };
        }
        if (sourceId === game.system?.id) {
            return { id: `source:${sourceId}`, label: game.system?.title || sourceId };
        }
        const module = game.modules?.get(sourceId);
        if (module) {
            return { id: `source:${sourceId}`, label: module.title || module.id || sourceId };
        }
        return { id: `source:${sourceId}`, label: sourceId };
    }

    static _getPackDisplayLabel(pack) {
        const title = pack?.metadata?.label || pack?.title || pack?.collection || "Compendium";
        if (title && title !== pack?.documentName) return title;
        const shortName = String(pack?.collection || "").split(".").slice(1).join(".");
        return shortName || title;
    }

    /**
     * Find duplicate items based on name.
     * @param {Array} assets 
     * @returns {Object} Grouped duplicates
     */
    static findDuplicates(assets) {
        const groups = {};
        for (const asset of assets) {
            const key = asset.name.toLowerCase();
            if (!groups[key]) groups[key] = [];
            groups[key].push(asset);
        }

        
        return Object.fromEntries(
            Object.entries(groups).filter(([_, list]) => list.length > 1)
        );
    }

    /**
     * Build a usage map for all actors at once.
     * @returns {Map<string, string[]>} actorId a scene names
     */
    static buildUsageIndex() {
        const usageMap = new Map();

        for (const scene of game.scenes) {
            const sceneName = scene.name;
            
            const actorsOnScene = new Set();
            for (const token of scene.tokens) {
                const actorId = token.actorId || token.actor?.id;
                if (actorId) actorsOnScene.add(actorId);
            }

            for (const actorId of actorsOnScene) {
                if (!usageMap.has(actorId)) {
                    usageMap.set(actorId, []);
                }
                usageMap.get(actorId).push(sceneName);
            }
        }

        return usageMap;
    }

    /**
     * Check if an actor is used in any scene.
     * Use buildUsageIndex() for bulk operations.
     * @param {string} actorId 
     * @returns {Array} List of scene names
     */
    static findUsage(actorId) {
        const usedIn = [];
        
        for (const scene of game.scenes) {
            
            const hasToken = scene.tokens.some(t => {
                return t.actorId === actorId || (t.actor?.id === actorId);
            });
            if (hasToken) usedIn.push(scene.name);
        }
        return usedIn;
    }
}
