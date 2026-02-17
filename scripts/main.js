import { registerSettings } from "./settings.js";
import { AssetLibrarian } from "./asset-librarian.js";
import { DataManager } from "./data-manager.js";
import { ImageScanner } from "./image-scanner.js";
import { ASSET_LIBRARIAN_BASE_TABS, helpers } from "./helpers.js";
import { CATEGORY_TAG_PATH, FILTER_TAG_PATH } from "./asset-tags.js";
let librarianInstance = null;
let worldRenderDebounce = null;
const MODULE_ID = "asset-librarian";

function injectCompendiumIndexFields() {
    const fieldsToInject = [CATEGORY_TAG_PATH, FILTER_TAG_PATH];

    for (const documentName of CONST.COMPENDIUM_DOCUMENT_TYPES) {
        const DocClass = CONFIG[documentName]?.documentClass;
        if (!DocClass) continue;

        const currentMetadata = DocClass.metadata || {};
        const existingFields = new Set(currentMetadata.compendiumIndexFields || []);
        let modified = false;

        for (const field of fieldsToInject) {
            if (existingFields.has(field)) continue;
            existingFields.add(field);
            modified = true;
        }

        if (!modified) continue;

        const newMetadata = {
            ...currentMetadata,
            compendiumIndexFields: Array.from(existingFields),
        };

        Object.defineProperty(DocClass, "metadata", {
            value: Object.freeze(newMetadata),
            writable: false,
            configurable: true,
        });

        console.log(`Asset Librarian | Injected compendium index fields for ${documentName}`);
    }
}

function ensureLibrarianInstance() {
    if (!game.assetLibrarian.instance) {
        game.assetLibrarian.instance = new AssetLibrarian();
    }
    return game.assetLibrarian.instance;
}

function invalidateInstanceCache({ mode, tab } = {}) {
    const instance = game.assetLibrarian?.instance;
    if (instance?.invalidateDataCache) {
        instance.invalidateDataCache({ mode, tab });
    }
}

function scheduleWorldRender(tab) {
    const instance = game.assetLibrarian?.instance;
    if (!instance?.rendered) return;
    if (instance.mode !== "world" || instance.activeTab !== tab) return;
    clearTimeout(worldRenderDebounce);
    worldRenderDebounce = setTimeout(() => instance.render(), 100);
}

async function maybeShowWelcomeMessage() {
    if (!game.user.isGM) return;
    if (!game.settings.get(MODULE_ID, "showWelcomeMessage")) return;

    const moduleVersion = game.modules.get(MODULE_ID)?.version ?? "";
    const lastSeenVersion = game.settings.get(MODULE_ID, "lastWelcomeVersion") || "";
    if (!moduleVersion || moduleVersion === lastSeenVersion) return;
    const content = await foundry.applications.handlebars.renderTemplate("modules/asset-librarian/templates/welcome-message.hbs");


    await ChatMessage.create({
        user: game.user.id,
        speaker: ChatMessage.getSpeaker(),
        content,
    });

    await game.settings.set(MODULE_ID, "lastWelcomeVersion", moduleVersion);
}

Hooks.once("init", async () => {
    console.log("Asset Librarian | Initializing");
    injectCompendiumIndexFields();
    game.assetLibrarian = {
        instance: null,
        DataManager: DataManager,
        open: (mode = null, tab = null, options = null) => ensureLibrarianInstance().openView(mode, tab, options),
        render: (mode = null, tab = null, options = null) => ensureLibrarianInstance().openView(mode, tab, options),
    };
    registerSettings();

    Handlebars.registerHelper("trim", (value) => {
      return typeof value === "string" ? value.trim() : value;
    });

    Handlebars.registerHelper("nospace", (value) => {
      return typeof value === "string" ? value.replace(/\s+/g, "") : value;
    });

    game.keybindings.register("asset-librarian", "openLibrarian", {
        name: "Open Asset Librarian",
        editable: [{ key: "KeyL", modifiers: [foundry.helpers.interaction.KeyboardManager.MODIFIER_KEYS.CONTROL] }],
        onDown: () => {
            if (game.assetLibrarian.instance?.rendered) {
                game.assetLibrarian.instance.close();
            } else {
                game.assetLibrarian.open();
            }
        },
    });

    await foundry.applications.handlebars.loadTemplates([
        "modules/asset-librarian/templates/asset-librarian.hbs",
        "modules/asset-librarian/templates/compendium-selector.hbs",
        "modules/asset-librarian/templates/custom-filter-fields.hbs",
        "modules/asset-librarian/templates/welcome-message.hbs",
        "modules/asset-librarian/templates/tag-group-config.hbs",
        "modules/asset-librarian/templates/bulk-tag-editor.hbs",
        "modules/asset-librarian/templates/tag-editor.hbs",
        "modules/asset-librarian/templates/folder-tree-partial.hbs",
    ]);
});

Hooks.on("ready", () => {
    console.log("Asset Librarian | Ready");
    setTimeout(() => {
        DataManager.cacheAll().catch((err) => {
            console.warn("Asset Librarian | Failed to warm compendium cache:", err);
        });
    }, 1500);
    setTimeout(() => {
        if (!ImageScanner.isEnabled()) return;
        ImageScanner.hydrateCacheFromDisk().catch((err) => {
            console.warn("Asset Librarian | Failed to hydrate image index cache:", err);
        });
    }, 1700);
    setTimeout(() => {
        if (!ImageScanner.isEnabled()) return;
        ImageScanner.startBackgroundScan().catch((err) => {
            console.warn("Asset Librarian | Failed to warm image cache:", err);
        });
    }, 2500);
    game.assetLibrarian.knownPacks = new Set(game.packs.keys());
    maybeShowWelcomeMessage().catch((err) => console.warn("Asset Librarian | Failed to show welcome message:", err));
});

Hooks.on("updateCompendium", (pack) => {
    if (pack) {
        DataManager.invalidateCompendiumCache(pack.collection);
        invalidateInstanceCache({ mode: "compendium", tab: pack.documentName });
        if (
            game.assetLibrarian.instance?.rendered &&
            game.assetLibrarian.instance.mode === "compendium" &&
            game.assetLibrarian.instance.activeTab === pack.documentName
        ) {
            game.assetLibrarian.instance.render();
        }
    }
});

Hooks.on("renderCompendiumDirectory", (app, html, data) => {
    const currentPacks = new Set(game.packs.keys());
    const knownPacks = game.assetLibrarian.knownPacks || new Set();

    if (currentPacks.size === knownPacks.size && [...currentPacks].every((packCode) => knownPacks.has(packCode))) {
        return;
    }

    for (const packCode of knownPacks) {
        if (!currentPacks.has(packCode)) {
            console.log(`Asset Librarian | Pack deleted: ${packCode}`);
            DataManager.invalidateCompendiumCache(packCode);
            invalidateInstanceCache({ mode: "compendium" });
            if (game.assetLibrarian.instance?.rendered && game.assetLibrarian.instance.mode === "compendium") {
                game.assetLibrarian.instance.render();
            }
        }
    }

    for (const packCode of currentPacks) {
        if (!knownPacks.has(packCode)) {
            console.log(`Asset Librarian | Pack added: ${packCode}`);
            invalidateInstanceCache({ mode: "compendium" });
        }
    }

    game.assetLibrarian.knownPacks = currentPacks;
});

const trackedWorldTypes = [...ASSET_LIBRARIAN_BASE_TABS];
for (const type of trackedWorldTypes) {
    Hooks.on(`create${type}`, () => {
        invalidateInstanceCache({ mode: "world", tab: type });
        scheduleWorldRender(type);
    });
    Hooks.on(`update${type}`, () => {
        invalidateInstanceCache({ mode: "world", tab: type });
        scheduleWorldRender(type);
    });
    Hooks.on(`delete${type}`, () => {
        invalidateInstanceCache({ mode: "world", tab: type });
        scheduleWorldRender(type);
    });
}

Hooks.on("getSceneControlButtons", (controls) => {
    const allowPlayers = game.settings.get(MODULE_ID, "allowPlayersSceneControl");
    if (!game.user.isGM && !allowPlayers) return;

    controls["asset-librarian"] = {
        name: "asset-librarian",
        title: game.i18n.localize("ASSET_LIBRARIAN.Controls.PaletteTitle"),
        icon: "fas fa-book",
        visible: true,
        button: true,
        onChange: (event, active) => {
            if (active) canvas.tokens.activate();
        },
        onToolChange: () => {},
        tools: {
            browser: {
                name: "browser",
                title: game.i18n.localize("ASSET_LIBRARIAN.Controls.OpenBrowser"),
                icon: "fas fa-search",
                button: true,
                onChange: () => {
                    if (game.assetLibrarian.instance?.rendered) {
                        game.assetLibrarian.instance.close();
                    } else {
                        game.assetLibrarian.open();
                    }
                },
            },
        },
        activeTool: "browser",
    };
});

Hooks.on("dropCanvasData", async (canvas, data) => {
    if (!game.user.isGM) return;
    if (!canvas?.scene) return;
    if (!data || data.type !== "Image" || !data.src || data.fromAssetLibrarian !== true) return;

    try {
        const texture = await foundry.canvas.loadTexture(data.src);
        const width = texture?.baseTexture?.width ?? texture?.width ?? 100;
        const height = texture?.baseTexture?.height ?? texture?.height ?? 100;
        const x = Number.isFinite(data.x) ? data.x - width / 2 : 0;
        const y = Number.isFinite(data.y) ? data.y - height / 2 : 0;

        await canvas.scene.createEmbeddedDocuments("Tile", [
            {
                texture: { src: data.src },
                width,
                height,
                x,
                y,
            },
        ]);

        return false;
    } catch (err) {
        console.warn("Asset Librarian | Failed to create tile from dropped image:", err);
    }
});
