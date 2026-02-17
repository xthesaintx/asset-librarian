
/**
 * ImageScanner - Scans directories for image files using FilePicker API
 */
export class ImageScanner {
    static EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'avif', 'bmp'];
    static _cachedImages = [];
    static _cacheKey = "";
    static _scanPromise = null;
    static _indexLoadPromise = null;
    static _lastScanMeta = null;
    static INDEX_FILENAME = "image-index.json";

    static _isDebugEnabled() {
        try {
            return game.settings.get("asset-librarian", "debugCacheLogs") === true;
        } catch (_err) {
            return false;
        }
    }

    static _debug(message, extra = undefined) {
        if (!this._isDebugEnabled()) return;
        if (extra === undefined) console.log(`Asset Librarian | ${message}`);
        else console.log(`Asset Librarian | ${message}`, extra);
    }

    static isForgeEnvironment() {
        return (
            typeof ForgeVTT !== "undefined" ||
            game.modules?.get("forge-vtt")?.active ||
            window.location.hostname.includes("forge-vtt.com")
        );
    }

    static getFilePickerSources() {
        if (this.isForgeEnvironment() && typeof ForgeVTT !== "undefined") {
            return ["forgevtt", "data"];
        }
        return ["data"];
    }

    static getIndexDirectory() {
        return `worlds/${game.world.id}/assets/asset-librarian`;
    }

    static getIndexPath() {
        return `${this.getIndexDirectory()}/${this.INDEX_FILENAME}`;
    }

    static async _ensureDirectoryExists(source, folderPath) {
        const fp = foundry.applications.apps.FilePicker.implementation;
        try {
            await fp.browse(source, folderPath);
            return true;
        } catch (_err) {
            const parts = folderPath.split("/").filter(Boolean);
            let currentPath = "";
            for (const part of parts) {
                currentPath = currentPath ? `${currentPath}/${part}` : part;
                try {
                    await fp.browse(source, currentPath);
                } catch {
                    try {
                        await fp.createDirectory(source, currentPath);
                    } catch (_createErr) {
                        return false;
                    }
                }
            }
            return true;
        }
    }

    static async hydrateCacheFromDisk({ force = false } = {}) {
        const started = performance.now();
        if (!this.isEnabled()) return [];
        if (!force && Array.isArray(this._cachedImages) && this._cachedImages.length) return this.getCachedImages();
        if (this._indexLoadPromise) return this._indexLoadPromise;

        this._indexLoadPromise = (async () => {
            const fp = foundry.applications.apps.FilePicker.implementation;
            const dir = this.getIndexDirectory();
            const fileName = this.INDEX_FILENAME;
            const sources = this.getFilePickerSources();

            for (const source of sources) {
                try {
                    const listing = await fp.browse(source, dir);
                    const filePath = (listing?.files || []).find((f) => String(f).endsWith(`/${fileName}`));
                    if (!filePath) continue;
                    const json = await fetch(filePath).then((r) => r.json());
                    const images = Array.isArray(json?.images) ? json.images : [];
                    this._cachedImages = images;
                    if (typeof json?.scanKey === "string") this._cacheKey = json.scanKey;
                    this._debug("Image index hydrated from disk", {
                        count: images.length,
                        ms: Math.round(performance.now() - started),
                    });
                    return this.getCachedImages();
                } catch (_err) {
                    // Try the next source.
                }
            }
            this._debug("Image index hydrate skipped (no index found)", {
                ms: Math.round(performance.now() - started),
            });
            return this.getCachedImages();
        })().finally(() => {
            this._indexLoadPromise = null;
        });

        return this._indexLoadPromise;
    }

    static async _persistIndexToDisk(images, scanKey) {
        if (!game.user.isGM || !Array.isArray(images)) return;
        const payload = {
            version: 1,
            scanKey: String(scanKey || ""),
            updatedAt: Date.now(),
            images,
        };
        const file = new File(
            [JSON.stringify(payload)],
            this.INDEX_FILENAME,
            { type: "application/json" },
        );

        const fp = foundry.applications.apps.FilePicker.implementation;
        const dir = this.getIndexDirectory();
        const sources = this.getFilePickerSources();
        for (const source of sources) {
            const ok = await this._ensureDirectoryExists(source, dir);
            if (!ok) continue;
            try {
                await fp.upload(source, dir, file, {}, { notify: false });
                this._debug("Image index persisted", { source, count: images.length });
                return;
            } catch (_err) {
                // Try next source.
            }
        }
    }

    /**
     * Check if image scanning is enabled
     */
    static isEnabled() {
        return game.settings.get("asset-librarian", "enableImageScanning");
    }

    /**
     * Get configured scan paths
     */
    static getPaths() {
        const storedPaths = game.settings.get("asset-librarian", "imageScanPaths");
        const worldPath = `worlds/${game.world.id}`;
        const paths = [];
        
        const includeWorldPath = game.settings.get("asset-librarian", "includeWorldPath");
        if (includeWorldPath) paths.push(worldPath); 

        let rawPaths = [];
        if (Array.isArray(storedPaths)) rawPaths = storedPaths;
        else if (typeof storedPaths === "string") rawPaths = storedPaths.split(",");
        else if (storedPaths && typeof storedPaths === "object") rawPaths = Object.values(storedPaths);

        const customPaths = rawPaths
            .map((p) => String(p || "").trim())
            .filter((p) => p && p.toLocaleLowerCase() !== "cancel");
        if (customPaths.length) paths.push(...customPaths);

        return [...new Set(paths)]; 
    }

    static _getScanKey() {
        if (!this.isEnabled()) return "disabled";
        const includeWorldPath = game.settings.get("asset-librarian", "includeWorldPath") ? "1" : "0";
        const paths = this.getPaths().join("|");
        return `${includeWorldPath}:${paths}`;
    }

    /**
     * Scan a single path recursively for images
     * @param {string} path 
     * @param {string} source - FilePicker source (data, public, s3, etc.)
     * @returns {Promise<Array>}
     */
    static async scanPath(path, source = "data", images = [], { suppressWarnings = false } = {}) {
        const EXT_SET = new Set(this.EXTENSIONS);
        try {
            const result = await foundry.applications.apps.FilePicker.implementation.browse(source, path);
            
            for (const file of result.files) {
                const ext = file.split('.').pop().toLowerCase();
                if (EXT_SET.has(ext)) {
                    images.push({
                        id: file,
                        name: file.split('/').pop(),
                        img: file,
                        uuid: file,
                        type: 'Image',
                        folder: path,
                        extension: ext
                    });
                }
            }

            
            for (const dir of result.dirs) {
                await this.scanPath(dir, source, images, { suppressWarnings: true });
            }
            return true;
        } catch (err) {
            if (!suppressWarnings) {
                console.warn(`Asset Librarian | Failed to scan path ${path} (source: ${source}):`, err.message);
            }
            return false;
        }
    }

    /**
     * Get all images from configured paths
     * @returns {Promise<Array>}
     */
    static async getImages() {
        if (!this.isEnabled()) return [];

        const paths = this.getPaths();
        const allImages = [];

        for (const path of paths) {
            let scanned = false;
            for (const source of this.getFilePickerSources()) {
                scanned = await this.scanPath(path, source, allImages, { suppressWarnings: true });
                if (scanned) break;
            }
            if (!scanned) {
                console.warn(`Asset Librarian | Failed to scan path ${path} for all available sources.`);
            }
        }

        return allImages;
    }

    static getCachedImages() {
        if (!this.isEnabled()) return [];
        return Array.isArray(this._cachedImages) ? [...this._cachedImages] : [];
    }

    static invalidateImageCache() {
        this._cachedImages = [];
        this._cacheKey = "";
        this._indexLoadPromise = null;
        this._lastScanMeta = null;
    }

    static _buildImageSignature(image) {
        const src = String(image?.img || image?.id || "");
        const name = String(image?.name || "");
        const folder = String(image?.folder || "");
        const extension = String(image?.extension || "");
        return `${src}::${name}::${folder}::${extension}`;
    }

    static _computeDiff(previousImages, nextImages) {
        const prev = Array.isArray(previousImages) ? previousImages : [];
        const next = Array.isArray(nextImages) ? nextImages : [];
        const prevById = new Map(prev.map((img) => [String(img?.id || img?.img || ""), img]));
        const nextById = new Map(next.map((img) => [String(img?.id || img?.img || ""), img]));
        const added = [];
        const removed = [];
        let changed = 0;

        for (const [id, nextImage] of nextById.entries()) {
            if (!id) continue;
            const prevImage = prevById.get(id);
            if (!prevImage) {
                added.push(id);
                continue;
            }
            if (this._buildImageSignature(prevImage) !== this._buildImageSignature(nextImage)) changed += 1;
        }
        for (const id of prevById.keys()) {
            if (!id) continue;
            if (!nextById.has(id)) removed.push(id);
        }

        return {
            added,
            removed,
            changed,
            counts: {
                added: added.length,
                removed: removed.length,
                changed,
            },
        };
    }

    static getLastScanMeta() {
        return this._lastScanMeta ? foundry.utils.deepClone(this._lastScanMeta) : null;
    }

    static startBackgroundScan({ force = false } = {}) {
        const nextKey = this._getScanKey();
        if (!this.isEnabled()) {
            this._cachedImages = [];
            this._cacheKey = nextKey;
            this._lastScanMeta = null;
            return Promise.resolve([]);
        }

        if (!force && this._scanPromise) return this._scanPromise;

        const hasValidCache = this._cacheKey === nextKey && this._cachedImages.length;
        if (!force && hasValidCache) return Promise.resolve(this.getCachedImages());

        const started = performance.now();
        const previous = this.getCachedImages();
        this._scanPromise = this.getImages()
            .then((images) => {
                this._cachedImages = Array.isArray(images) ? images : [];
                this._cacheKey = nextKey;
                const diff = this._computeDiff(previous, this._cachedImages);
                this._lastScanMeta = {
                    scanKey: nextKey,
                    startedAt: Date.now(),
                    durationMs: Math.round(performance.now() - started),
                    counts: {
                        total: this._cachedImages.length,
                        ...diff.counts,
                    },
                    added: diff.added,
                    removed: diff.removed,
                    changed: diff.changed,
                };
                this._debug("Image scan complete", this._lastScanMeta);
                void this._persistIndexToDisk(this._cachedImages, nextKey);
                return this.getCachedImages();
            })
            .catch((err) => {
                console.warn("Asset Librarian | Background image scan failed:", err);
                return this.getCachedImages();
            })
            .finally(() => {
                this._scanPromise = null;
            });

        return this._scanPromise;
    }

    /**
     * Build folder tree from image paths
     * @param {Array} images 
     * @returns {Array}
     */
    static buildFolderTree(images) {
        const nodeMap = new Map();
        const roots = [];

        const ensureNode = (id, name, parentId, depth) => {
            if (nodeMap.has(id)) return nodeMap.get(id);
            const node = {
                id,
                name,
                parent: parentId,
                depth,
                sort: name,
                count: 0,
                children: [],
            };
            nodeMap.set(id, node);
            if (parentId) {
                const parent = nodeMap.get(parentId);
                if (parent) parent.children.push(node);
                else roots.push(node);
            } else {
                roots.push(node);
            }
            return node;
        };

        for (const img of images) {
            const folderPath = String(img?.folder || "").trim();
            if (!folderPath) continue;

            const parts = folderPath.split("/").filter(Boolean);
            if (!parts.length) continue;

            let parentId = null;
            let currentPath = "";

            for (let i = 0; i < parts.length; i++) {
                const part = parts[i];
                currentPath = currentPath ? `${currentPath}/${part}` : part;
                const node = ensureNode(currentPath, part, parentId, i + 1);
                if (i === parts.length - 1) node.count += 1;
                parentId = currentPath;
            }
        }

        const sortTree = (nodes) => {
            nodes.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
            for (const node of nodes) {
                if (node.children?.length) sortTree(node.children);
            }
        };

        sortTree(roots);
        return roots;
    }
}
/**
 * Open dialog to configure image scan paths with a directory picker
 */
export async function openImagePathsDialog() {
    const currentPaths = game.settings.get("asset-librarian", "imageScanPaths");
    const i18n = game.i18n;
    const initialPaths = Array.isArray(currentPaths)
        ? currentPaths.map((p) => String(p || "").trim()).filter(Boolean)
        : [];
    const rows = initialPaths.length ? initialPaths : [""];
    const escapedRows = rows.map((p) => foundry.utils.escapeHTML(p));
    const rowsHtml = escapedRows
        .map((p, i) => `
            <div class="path-row" data-row-index="${i}" style="display:flex; gap:6px; align-items:center; margin-bottom:6px;">
                <input type="text" class="path-input" value="${p}" placeholder="" style="flex:1;" />
                <button type="button" class="path-browse-btn" style="width:auto; flex:0;">
                    <i class="fas fa-folder-open"></i>
                </button>
                <button type="button" class="path-remove-btn" style="width:auto; flex:0;">
                    <i class="fas fa-trash"></i>
                </button>
            </div>
        `)
        .join("");

    const content = `
        <div class="asset-librarian-dialog">
            <p>${i18n.localize("ASSET_LIBRARIAN.Images.EnterPaths")}</p>
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                <div style="display:flex; gap:6px; align-items:center; flex:1;">
                    <button type="button" class="path-build-cache-btn" style="width: auto; flex: 1 0 30%;">
                        <i class="fas fa-wand-magic-sparkles"></i> Build Thumb Cache
                    </button>
                    <button type="button" class="path-add-row-btn" style="width: auto; flex: 0;">
                        <i class="fas fa-circle-plus"></i>
                    </button>
                </div>
            </div>
            <div class="path-list">${rowsHtml}</div>
        </div>
    `;

    return new Promise((resolve) => {
        let didChange = false;
        let settled = false;
        const finish = (value) => {
            if (settled) return;
            settled = true;
            resolve(value);
        };

        const normalizePath = (raw) => {
            const trimmed = String(raw || "").trim().replace(/\\/g, "/");
            if (!trimmed) return "";
            if (trimmed.toLocaleLowerCase() === "cancel") return "";
            if (trimmed === "/") return trimmed;
            return trimmed.replace(/\/+$/g, "");
        };

        let savedSnapshot = "";
        const serializePaths = (paths) => JSON.stringify(Array.isArray(paths) ? paths : []);
        const collectPaths = (root) => {
            const values = [];
            const seen = new Set();
            for (const input of root.querySelectorAll(".path-input")) {
                const normalized = normalizePath(input.value);
                if (!normalized) continue;
                const key = normalized.toLocaleLowerCase();
                if (seen.has(key)) continue;
                seen.add(key);
                values.push(normalized);
            }
            return values;
        };
        const persistPaths = async (root) => {
            const values = collectPaths(root);
            const nextSnapshot = serializePaths(values);
            if (nextSnapshot === savedSnapshot) return false;
            await game.settings.set("asset-librarian", "imageScanPaths", values);
            ImageScanner.invalidateImageCache();
            savedSnapshot = nextSnapshot;
            didChange = true;
            return true;
        };

        savedSnapshot = serializePaths(
            initialPaths
                .map((p) => normalizePath(p))
                .filter(Boolean)
                .filter((p, i, arr) => arr.findIndex((x) => x.toLocaleLowerCase() === p.toLocaleLowerCase()) === i),
        );

        const dialog = new foundry.applications.api.DialogV2({
            window: { title: i18n.localize("ASSET_LIBRARIAN.Images.DialogTitle"), resizable: true, },
            classes: ["asset-librarian", "image-folder-picker"],
            position: {
               width: 600,
               height: 400
                },
            
            content,
            buttons: [
                {
                    action: "done",
                    label: "Done",
                    icon: "fas fa-check",
                    default: true,
                    callback: () => {
                        finish(didChange);
                        return didChange;
                    }
                }
            ],
            close: () => finish(didChange)
        });

        dialog.render(true).then(() => {
            const list = dialog.element.querySelector('.path-list');
            const addRowBtn = dialog.element.querySelector('.path-add-row-btn');
            const buildCacheBtn = dialog.element.querySelector('.path-build-cache-btn');
            if (!list || !addRowBtn) return;

            const bindRow = (row) => {
                const browseBtn = row.querySelector('.path-browse-btn');
                const removeBtn = row.querySelector('.path-remove-btn');
                const input = row.querySelector('.path-input');
                if (!browseBtn || !removeBtn || !input) return;

                browseBtn.addEventListener('click', () => {
                    new foundry.applications.apps.FilePicker.implementation({
                        type: "folder",
                        source: ImageScanner.getFilePickerSources()[0] || "data",
                        callback: async (path) => {
                            if (typeof path !== "string") return;
                            const normalizedPath = normalizePath(path);
                            if (!normalizedPath) return;
                            input.value = normalizedPath;
                            await persistPaths(list);
                        }
                    }).browse();
                });

                removeBtn.addEventListener('click', async () => {
                    const rows = list.querySelectorAll('.path-row');
                    if (rows.length <= 1) {
                        input.value = "";
                    } else {
                        row.remove();
                    }
                    await persistPaths(list);
                });

                input.addEventListener("change", async () => {
                    input.value = normalizePath(input.value);
                    await persistPaths(list);
                });
                input.addEventListener("blur", async () => {
                    input.value = normalizePath(input.value);
                    await persistPaths(list);
                });
            };

            for (const row of list.querySelectorAll('.path-row')) {
                bindRow(row);
            }

            addRowBtn.addEventListener('click', () => {
                const row = document.createElement('div');
                row.className = 'path-row';
                row.style.display = 'flex';
                row.style.gap = '6px';
                row.style.alignItems = 'center';
                row.style.marginBottom = '6px';
                row.innerHTML = `
                    <input type="text" class="path-input" value="" placeholder="" style="flex:1;" />
                    <button type="button" class="path-browse-btn" style="width:auto; flex:0;">
                        <i class="fas fa-folder-open"></i>
                    </button>
                    <button type="button" class="path-remove-btn" style="width:auto; flex:0;">
                        <i class="fas fa-trash"></i>
                    </button>
                `;
                list.appendChild(row);
                bindRow(row);
                row.querySelector(".path-input")?.focus();
            });

            buildCacheBtn?.addEventListener("click", async () => {
                await persistPaths(list);
                const instance = game.assetLibrarian?.instance;
                if (!instance || typeof instance.buildImageThumbnailCache !== "function") {
                    ui.notifications.warn("Asset Librarian | Open Asset Librarian before building thumbnail cache.");
                    return;
                }
                await instance.buildImageThumbnailCache({ forceRescan: true });
            });

        });
    });
}
