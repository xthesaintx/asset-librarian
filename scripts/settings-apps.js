/**
 * Settings Application Classes for Asset Librarian
 * These are ApplicationV2 classes for use as settings menus
 */
import { DataManager } from './data-manager.js';
import { ASSET_LIBRARIAN_BASE_TABS, helpers } from "./helpers.js";
const ApplicationV2 = foundry.applications.api.ApplicationV2;
const HandlebarsApplicationMixin = foundry.applications.api.HandlebarsApplicationMixin;
import { getCategoryGroups } from "./category-groups.js";
import { DEFAULT_MAPPINGS as IMPORTED_DEFAULT_MAPPINGS } from "./default-mappings.js";
import { ASSET_LIBRARIAN_FLAG_SCOPE, ASSET_LIBRARIAN_TAG_REGISTRY_SETTING, FLAG_TAG_TABS, getOrderedTagGroupsForDocType, normalizeTag, normalizeTagList, tagToken } from "./asset-tags.js";

/**
 * Compendium Selector Application
 * Allows users to select which compendiums to include when browsing
 */
export class CompendiumSelectorApp extends HandlebarsApplicationMixin(ApplicationV2) {
    static DEFAULT_OPTIONS = {
        id: "asset-librarian-compendium-selector",
        classes: ["asset-librarian", "compendium-selector", "dialog"],
        tag: "form",
        window: {
            icon: "fas fa-boxes-stacked",
            title: "ASSET_LIBRARIAN.Compendiums.WindowTitle",
            resizable: true,
            contentClasses: ["standard-form"]
        },
        position: { width: 600, height: 600 },
        form: {
            handler: this.#onSubmitForm,
            closeOnSubmit: true,
            submitOnChange: false
        },
        actions: {
            selectAll: this.#onSelectAll,
            selectNone: this.#onSelectNone,
            refreshCache: this.#onRefreshCache
        }
    };

    static PARTS = {
        form: {
            template: "modules/asset-librarian/templates/compendium-selector.hbs"
        },
        footer: {
            template: "templates/generic/form-footer.hbs"
        }
    };

    async _prepareContext(options) {
        const context = await super._prepareContext(options);
        const currentSettings = game.settings.get("asset-librarian", "includedCompendiums") || {};

        const packGroups = [...ASSET_LIBRARIAN_BASE_TABS].map((type) => ({
            type,
            label: game.i18n.localize(`ASSET_LIBRARIAN.Tabs.${type}`),
            packs: []
        }));
        const groupByType = new Map(packGroups.map((g) => [g.type, g]));

        for (const pack of game.packs) {
            const group = groupByType.get(pack.documentName);
            if (group) {
                group.packs.push({
                    packName: pack.metadata?.packageName || pack.collection.split('.')[0] || "",
                    collection: pack.collection,
                    title: pack.title,
                    checked: !!currentSettings[pack.collection]
                });
            }
        }

        
        for (const group of packGroups) {
            group.packs.sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: "base" }));
        }

        context.packGroups = packGroups.filter((g) => g.packs.length > 0);
        context.buttons = this._getButtons();
        return context;
    }

    _getButtons() {
        return [
            { type: "button", action: "refreshCache", icon: "fas fa-sync", label: game.i18n.localize("ASSET_LIBRARIAN.Compendiums.RefreshCache") },
            { type: "button", action: "selectAll", icon: "fas fa-check-double", label: game.i18n.localize("ASSET_LIBRARIAN.Compendiums.SelectAll") },
            { type: "button", action: "selectNone", icon: "fas fa-times", label: game.i18n.localize("ASSET_LIBRARIAN.Compendiums.SelectNone") },
            { type: "submit", icon: "fas fa-save", label: game.i18n.localize("ASSET_LIBRARIAN.Compendiums.Save") }
        ];
    }

    static async #onSubmitForm(event, form, formData) {
        const selected = {};
        const packsByType = Object.fromEntries(ASSET_LIBRARIAN_BASE_TABS.map((type) => [type, true]));
        const oldSettings = game.settings.get("asset-librarian", "includedCompendiums") || {};

        for (const pack of game.packs) {
            if (packsByType[pack.documentName]) {
                const isSelected = formData.object[pack.collection] || false;
                selected[pack.collection] = isSelected;

                if (oldSettings[pack.collection] && !isSelected) {
                    DataManager.invalidateCompendiumCache(pack.collection);
                }
            }
        }

        await game.settings.set("asset-librarian", "includedCompendiums", selected);
        const count = Object.values(selected).filter(Boolean).length;
        ui.notifications.info(game.i18n.format("ASSET_LIBRARIAN.Compendiums.SelectedCount", { count }));
        if (game.assetLibrarian?.instance?.rendered) {
            game.assetLibrarian.instance.invalidateDataCache?.({ mode: "compendium" });
            game.assetLibrarian.instance.render(true);
        }
    }

    static async #onSelectAll(event) {
        const checkboxes = this.element.querySelectorAll('input[type="checkbox"]');
        checkboxes.forEach(cb => cb.checked = true);
    }

    static async #onSelectNone(event) {
        const checkboxes = this.element.querySelectorAll('input[type="checkbox"]');
        checkboxes.forEach(cb => cb.checked = false);
    }

    static async #onRefreshCache(event, target) {
        const icon = target.querySelector("i");
        if (icon) icon.classList.add("fa-spin");

        DataManager.invalidateCompendiumCache();

        await new Promise(resolve => setTimeout(resolve, 500));

        if (icon) icon.classList.remove("fa-spin");

        ui.notifications.info(game.i18n.localize("ASSET_LIBRARIAN.Compendiums.CacheRefreshed"));

        if (game.assetLibrarian?.instance?.rendered) {
            game.assetLibrarian.instance.render(true);
        }
    }


}

/**
 * Custom Filter Fields Application
 * Allows users to configure custom fields for filtering
 */
export class CustomFilterFieldsApp extends HandlebarsApplicationMixin(ApplicationV2) {
    static DOC_TYPES = [...ASSET_LIBRARIAN_BASE_TABS];

    static DEFAULT_OPTIONS = {
        id: "asset-librarian-custom-fields",
        classes: ["asset-librarian", "custom-filter-fields", "dialog"],
        tag: "form",
        window: {
            icon: "fas fa-filter",
            title: "ASSET_LIBRARIAN.CustomFilters.WindowTitle",
            contentClasses: ["standard-form"],
            resizable: true,
        },
        position: { width: 550, height: 600 },
        form: {
            handler: this.#onSubmitForm,
            closeOnSubmit: true,
            submitOnChange: false
        },
        actions: {
            addField: this.#onAddField,
            removeField: this.#onRemoveField,
            exportFields: this.#onExportFields,
            importFields: this.#onImportFields,
            applyImport: this.#onApplyImport
        }
    };

    static PARTS = {
        form: {
            template: "modules/asset-librarian/templates/custom-filter-fields.hbs"
        },
        footer: {
            template: "templates/generic/form-footer.hbs"
        }
    };

    async _prepareContext(options) {
        const context = await super._prepareContext(options);
        const currentFields = game.settings.get("asset-librarian", "customFilterFields") || {};

        const sections = [];
        for (const docType of CustomFilterFieldsApp.DOC_TYPES) {
            const fields = currentFields[docType] || [];
            sections.push({
                docType,
                label: `${docType}`,
                fields: fields.map((f, i) => ({
                    index: i,
                    key: f.key,
                    label: f.label,
                    path: f.path
                }))
            });
        }

        context.sections = sections;
        context.buttons = this._getButtons();
        return context;
    }

    _getButtons() {
        return [
            { type: "submit", icon: "fas fa-save", label: game.i18n.localize("ASSET_LIBRARIAN.CustomFilters.Save") }
        ];
    }

    static async #onSubmitForm(event, form, formData) {
        const result = {};
        for (const docType of CustomFilterFieldsApp.DOC_TYPES) {
            result[docType] = [];
            const rowsByIndex = new Map();
            const prefix = `${docType}-`;

            for (const [name, rawValue] of Object.entries(formData.object)) {
                if (!name.startsWith(prefix)) continue;
                const match = name.match(new RegExp(`^${docType}-(key|label|path)-(\\d+)$`));
                if (!match) continue;
                const [, fieldName, idxRaw] = match;
                const idx = Number(idxRaw);
                if (!rowsByIndex.has(idx)) rowsByIndex.set(idx, {});
                rowsByIndex.get(idx)[fieldName] = typeof rawValue === "string" ? rawValue.trim() : rawValue;
            }

            const sortedIndexes = Array.from(rowsByIndex.keys()).sort((a, b) => a - b);
            for (const idx of sortedIndexes) {
                const row = rowsByIndex.get(idx) || {};
                const key = row.key?.trim?.() ?? row.key;
                const label = row.label?.trim?.() ?? row.label;
                const path = row.path?.trim?.() ?? row.path;
                if (key && label && path) {
                    result[docType].push({ key, label, path });
                }
            }
        }
        
        await game.settings.set("asset-librarian", "customFilterFields", result);
        ui.notifications.info(game.i18n.localize("ASSET_LIBRARIAN.CustomFilters.Saved"));
        DataManager.invalidateCache();
        if (game.assetLibrarian?.instance?.rendered) {
            game.assetLibrarian.instance.invalidateDataCache?.();
            if (typeof game.assetLibrarian.instance.wrappedOnResetFilters === "function") {
                game.assetLibrarian.instance.wrappedOnResetFilters();
            } else {
                game.assetLibrarian.instance._lastComputedFilterStateKey = null;
            }
            game.assetLibrarian.instance.render(true);
        }
    }

    static #onAddField(event, target) {
        const docType = target.dataset.docType;
        const fieldsList = this.element.querySelector(`[data-doc-type="${docType}"] .fields-list`);
        const index = fieldsList.querySelectorAll('.field-row').length;

        const newRow = document.createElement('div');
        newRow.className = 'field-row';
        newRow.dataset.index = index;
        const keyPlaceholder = game.i18n.localize("ASSET_LIBRARIAN.CustomFilters.PlaceholderKey");
        const labelPlaceholder = game.i18n.localize("ASSET_LIBRARIAN.CustomFilters.PlaceholderLabel");
        const pathPlaceholder = game.i18n.localize("ASSET_LIBRARIAN.CustomFilters.PlaceholderPath");
        newRow.innerHTML = `
      <input type="text" name="${docType}-key-${index}" value="" placeholder="${keyPlaceholder}">
      <input type="text" name="${docType}-label-${index}" value="" placeholder="${labelPlaceholder}">
      <input type="text" name="${docType}-path-${index}" value="" placeholder="${pathPlaceholder}" class="path-input">
      <button type="button" class="remove-field-btn" data-action="removeField" data-doc-type="${docType}" data-index="${index}">
        <i class="fas fa-times"></i>
      </button>
    `;
        fieldsList.appendChild(newRow);
    }

    static #onRemoveField(event, target) {
        const row = target.closest('.field-row');
        if (row) row.remove();
    }

    static #onExportFields(event, target) {
        const exportData = {};
        for (const docType of CustomFilterFieldsApp.DOC_TYPES) {
            exportData[docType] = [];
            const section = this.element.querySelector(`[data-doc-type="${docType}"]`);
            const rows = section.querySelectorAll('.field-row');
            rows.forEach((row, i) => {
                const key = row.querySelector(`[name="${docType}-key-${i}"]`)?.value?.trim();
                const label = row.querySelector(`[name="${docType}-label-${i}"]`)?.value?.trim();
                const path = row.querySelector(`[name="${docType}-path-${i}"]`)?.value?.trim();
                if (key && label && path) {
                    exportData[docType].push({ key, label, path });
                }
            });
        }
        const filename = "asset-librarian-filters.json";
        foundry.utils.saveDataToFile(JSON.stringify(exportData, null, 2), "text/json", filename);
        ui.notifications.info(game.i18n.localize("ASSET_LIBRARIAN.CustomFilters.Exported"));
    }

    static #onImportFields(event, target) {
        
        const fileInput = this.element.querySelector('.import-file-input');
        if (fileInput) {
            fileInput.click();
        }
    }

    static #onApplyImport(event, target) {
        
        const file = target.files?.[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const imported = JSON.parse(e.target.result);
                this._applyImportedData.call(this, imported);
            } catch (err) {
                ui.notifications.error(game.i18n.localize("ASSET_LIBRARIAN.CustomFilters.InvalidJson"));
            }
        };
        reader.readAsText(file);
        target.value = ''; 
    }

    _applyImportedData(imported) {
        for (const docType of CustomFilterFieldsApp.DOC_TYPES) {
            if (!imported[docType]) continue;

            const section = this.element.querySelector(`[data-doc-type="${docType}"]`);
            const fieldsList = section.querySelector('.fields-list');

            for (const field of imported[docType]) {
                if (!field.key || !field.label || !field.path) continue;

                const index = fieldsList.querySelectorAll('.field-row').length;
                const newRow = document.createElement('div');
                newRow.className = 'field-row';
                newRow.dataset.index = index;
                const keyPlaceholder = game.i18n.localize("ASSET_LIBRARIAN.CustomFilters.PlaceholderKey");
                const labelPlaceholder = game.i18n.localize("ASSET_LIBRARIAN.CustomFilters.PlaceholderLabel");
                const pathPlaceholder = game.i18n.localize("ASSET_LIBRARIAN.CustomFilters.PlaceholderPath");
                newRow.innerHTML = `
          <input type="text" name="${docType}-key-${index}" value="${field.key}" placeholder="${keyPlaceholder}">
          <input type="text" name="${docType}-label-${index}" value="${field.label}" placeholder="${labelPlaceholder}">
          <input type="text" name="${docType}-path-${index}" value="${field.path}" placeholder="${pathPlaceholder}" class="path-input">
          <button type="button" class="remove-field-btn" data-action="removeField" data-doc-type="${docType}" data-index="${index}">
            <i class="fas fa-times"></i>
          </button>
        `;
                fieldsList.appendChild(newRow);
            }
        }

        ui.notifications.info(game.i18n.localize("ASSET_LIBRARIAN.CustomFilters.Imported"));
    }


    async _renderFrame(options) {
        const frame = await super._renderFrame(options);
        if (!this.hasFrame) return frame;
        const copyId = `
            <button type="button" class="header-control fa-solid fa-download icon" data-action="exportFields" data-tooltip="Export"></button>
            <button type="button" class="header-control fa-solid fa-upload icon" data-action="importFields" data-tooltip="Import"></button>
          `;
        this.window.close.insertAdjacentHTML("beforebegin", copyId);
        return frame;
    }



    _onRender(context, options) {
        const fileInput = this.element.querySelector('.import-file-input');
        if (fileInput) {
            fileInput.addEventListener('change', (event) => {
                const file = event.target.files?.[0];
                if (!file) return;

                const reader = new FileReader();
                reader.onload = (e) => {
                    try {
                        const imported = JSON.parse(e.target.result);
                        this._applyImportedData(imported);
                    } catch (err) {
                        ui.notifications.error(game.i18n.localize("ASSET_LIBRARIAN.CustomFilters.InvalidJson"));
                    }
                };
                reader.readAsText(file);
                event.target.value = ''; 
            });
        }
    }
}

/**
 * Category Configuration Application
 * Allows users to map system types to high-level categories
 */
export class CategoryConfigApp extends HandlebarsApplicationMixin(ApplicationV2) {
    static get GROUPS() {
        return getCategoryGroups();
    }
    static DEFAULT_MAPPINGS = IMPORTED_DEFAULT_MAPPINGS;

    static DEFAULT_OPTIONS = {
        id: "asset-librarian-category-config",
        classes: ["asset-librarian", "category-config", "dialog"],
        tag: "form",
        window: {
            icon: "fas fa-tags",
            title: "ASSET_LIBRARIAN.CategoryConfig.WindowTitle",
            resizable: true,
            contentClasses: ["standard-form"]
        },
        position: { width: 600, height: "auto" }, 
        form: {
            handler: this.#onSubmitForm,
            closeOnSubmit: true,
            submitOnChange: false
        },
        actions: {
            resetDefaults: this.#onResetDefaults
        }
    };

    static PARTS = {
        form: {
            template: "modules/asset-librarian/templates/category-config.hbs"
        },
        footer: {
            template: "templates/generic/form-footer.hbs"
        }
    };

    async _prepareContext(options) {
        const context = await super._prepareContext(options);

        
        const savedConfig = game.settings.get("asset-librarian", "categoryConfig") || {};

        
        let defaults = {};
        if (CategoryConfigApp.DEFAULT_MAPPINGS[game.system.id]) {
            defaults = CategoryConfigApp.DEFAULT_MAPPINGS[game.system.id];
        }

        
        const isChecked = (group, type) => {
            if (savedConfig[group]) {
                return !!savedConfig[group][type];
            }
            
            if (defaults[group] && defaults[group].includes(type)) {
                return true;
            }
            return false;
        };

        
        const allTypes = [];

        if (game.system.documentTypes.Item) {
            const itemTypes = Array.isArray(game.system.documentTypes.Item)
                ? game.system.documentTypes.Item
                : Object.keys(game.system.documentTypes.Item);

            for (const type of itemTypes) {
                const label = game.i18n.localize(CONFIG.Item?.typeLabels?.[type]) || type;
                allTypes.push({ type, label });
            }
        }

        allTypes.sort((a, b) => a.label.localeCompare(b.label));
        const selectedCountByType = new Map();
        for (const t of allTypes) {
            let count = 0;
            for (const groupName of CategoryConfigApp.GROUPS) {
                if (groupName === "All") continue;
                if (isChecked(groupName, t.type)) count++;
            }
            selectedCountByType.set(t.type, count);
        }

        const groups = [];
        for (const groupName of CategoryConfigApp.GROUPS) {
            if (groupName === "All") continue;

            const groupTypes = allTypes.map(t => ({
                ...t,
                checked: isChecked(groupName, t.type),
                selectedElsewhere: (selectedCountByType.get(t.type) || 0) - (isChecked(groupName, t.type) ? 1 : 0) > 0
            }));

            groups.push({
                id: groupName,
                label: groupName,
                types: groupTypes
            });
        }

        context.groups = groups;
        context.buttons = this._getButtons();
        return context;
    }


    _onRender(context, options) {
        super._onRender(context, options);
        this.#updateCrossCategoryHighlights();
        this._crossCategoryChangeHandler ??= (event) => {
            const target = event.target;
            if (!(target instanceof HTMLInputElement)) return;
            if (target.type !== "checkbox") return;
            this.#updateCrossCategoryHighlights();
        };
        this.element.removeEventListener("change", this._crossCategoryChangeHandler);
        this.element.addEventListener("change", this._crossCategoryChangeHandler);
    }

    #updateCrossCategoryHighlights() {
        const inputs = this.element.querySelectorAll('.compendium-list input[type="checkbox"][name*="."]');
        if (!inputs.length) return;
        const selectedCountByType = new Map();
        for (const input of inputs) {
            const [, type] = (input.name || "").split(".");
            if (!type) continue;
            if (input.checked) {
                selectedCountByType.set(type, (selectedCountByType.get(type) || 0) + 1);
            }
        }

        for (const input of inputs) {
            const [, type] = (input.name || "").split(".");
            if (!type) continue;
            const row = input.closest(".compendium-item");
            if (!row) continue;
            const count = selectedCountByType.get(type) || 0;
            const selectedElsewhere = count - (input.checked ? 1 : 0) > 0;
            row.classList.toggle("selected-elsewhere", selectedElsewhere);
        }
    }
    _getButtons() {
        return [
            { type: "button", action: "resetDefaults", icon: "fas fa-times", label: game.i18n.localize("ASSET_LIBRARIAN.CategoryConfig.ResetDefaults") },
            { type: "submit", icon: "fas fa-save", label: game.i18n.localize("ASSET_LIBRARIAN.CategoryConfig.Save") }
        ];
    }

    static async #onSubmitForm(event, form, formData) {
        const config = {};

        for (const group of CategoryConfigApp.GROUPS) {
            if (group !== "All") config[group] = {};
        }

        for (const [key, value] of Object.entries(formData.object)) {
            if (value) {
                const [group, type] = key.split('.');
                if (group && type) {
                    if (!config[group]) config[group] = {};
                    config[group][type] = true;
                }
            }
        }

        await game.settings.set("asset-librarian", "categoryConfig", config);
        ui.notifications.info(game.i18n.localize("ASSET_LIBRARIAN.CategoryConfig.Saved"));
        DataManager.invalidateCache();
        if (game.assetLibrarian?.instance?.rendered) {
            game.assetLibrarian.instance.invalidateDataCache?.();
            if (typeof game.assetLibrarian.instance.wrappedOnResetFilters === "function") {
                game.assetLibrarian.instance.wrappedOnResetFilters();
            } else {
                game.assetLibrarian.instance._lastComputedFilterStateKey = null;
            }
            game.assetLibrarian.instance.render(true);
        }
    }

    static async #onResetDefaults(event, target) {
        const confirm = await helpers.confirmationDialog(game.i18n.localize("ASSET_LIBRARIAN.CategoryConfig.ResetConfirm"))
        
        if (confirm) {
            await game.settings.set("asset-librarian", "categoryConfig", {});
            ui.notifications.info(game.i18n.localize("ASSET_LIBRARIAN.CategoryConfig.ResetToDefaults"));
            this.render({ force: true });
            DataManager.invalidateCache();
            if (game.assetLibrarian?.instance?.rendered) {
                game.assetLibrarian.instance.invalidateDataCache?.();
                if (typeof game.assetLibrarian.instance.wrappedOnResetFilters === "function") {
                    game.assetLibrarian.instance.wrappedOnResetFilters();
                } else {
                    game.assetLibrarian.instance._lastComputedFilterStateKey = null;
                }
                game.assetLibrarian.instance.render(true);
            }
        }
    }
}


export class TagGroupConfigApp extends HandlebarsApplicationMixin(ApplicationV2) {
    static DOC_TYPES = FLAG_TAG_TABS;

    static DEFAULT_OPTIONS = {
        id: "asset-librarian-tag-group-config",
        classes: ["asset-librarian", "tag-group-config", "dialog"],
        tag: "form",
        window: {
            icon: "fas fa-tags",
            title: "ASSET_LIBRARIAN.TagGroupConfig.WindowTitle",
            resizable: true,
            contentClasses: ["standard-form"]
        },
        position: { width: 600, height: "auto" }, 
        form: {
            handler: this.#onSubmitForm,
            closeOnSubmit: true,
            submitOnChange: false
        },
        actions: {
            addTagGroup: this.#onAddTagGroup,
            removeTagGroup: this.#onRemoveTagGroup,
            removeDeadTag: this.#onRemoveDeadTag,
            resetDefaults: this.#onResetDefaults
        }
    };

    static PARTS = {
        form: {
            template: "modules/asset-librarian/templates/tag-group-config.hbs"
        },
        footer: {
            template: "templates/generic/form-footer.hbs"
        }
    };

    _workingConfig = null;
    _assignedFilterTagTokenCache = new Map();
    _assignedFilterTagTokenPromises = new Map();

    _getWorkingConfig() {
        if (!this._workingConfig) {
            this._workingConfig = foundry.utils.deepClone(game.settings.get("asset-librarian", "tagGroupConfig") || {});
            this.#normalizeWorkingConfig();
        }
        return this._workingConfig;
    }

    #normalizeWorkingConfig() {
        const config = this._workingConfig || {};
        for (const docType of TagGroupConfigApp.DOC_TYPES) {
            config[docType] ||= {};
            config[docType].groups ||= {};
            const groups = config[docType].groups;
            const validIds = new Set(Object.keys(groups));
            const existingOrder = Array.isArray(config[docType].groupOrder) ? config[docType].groupOrder : [];
            const mergedOrder = [];
            const seen = new Set();

            for (const groupId of existingOrder) {
                if (!validIds.has(groupId) || seen.has(groupId)) continue;
                seen.add(groupId);
                mergedOrder.push(groupId);
            }

            const remaining = Array.from(validIds)
                .filter((groupId) => !seen.has(groupId))
                .sort((leftId, rightId) => {
                    const leftLabel = normalizeTag(groups[leftId]?.label || leftId) || leftId;
                    const rightLabel = normalizeTag(groups[rightId]?.label || rightId) || rightId;
                    return leftLabel.localeCompare(rightLabel, undefined, { sensitivity: "base", numeric: true });
                });

            config[docType].groupOrder = [...mergedOrder, ...remaining];
        }
    }

    _syncWorkingConfigFromFormSelections() {
        const config = this._getWorkingConfig();
        if (!this.element) return config;

        for (const docType of TagGroupConfigApp.DOC_TYPES) {
            const groups = config?.[docType]?.groups;
            if (!groups) continue;
            for (const groupData of Object.values(groups)) {
                groupData.tags = {};
            }
        }

        const inputs = this.element.querySelectorAll('.compendium-list input[type="checkbox"][name*="|"]');
        for (const input of inputs) {
            const [docType, groupId, token] = String(input.name || "").split("|");
            if (!docType || !groupId || !token) continue;
            if (!config?.[docType]?.groups?.[groupId]) continue;
            if (input.checked) config[docType].groups[groupId].tags[token] = true;
        }

        return config;
    }

    _getTagsForDocType(docType, registry, configSection, assignedTokens = new Set()) {
        const labelByToken = new Map();
        for (const label of normalizeTagList(registry?.[docType]?.filters || [])) {
            const token = tagToken(label);
            labelByToken.set(token, label);
        }

        const groups = configSection?.groups || {};
        for (const group of Object.values(groups)) {
            for (const token of Object.keys(group?.tags || {})) {
                if (!labelByToken.has(token)) labelByToken.set(token, token);
            }
        }

        return Array.from(labelByToken.entries())
            .map(([token, label]) => ({ token, label, isDead: !assignedTokens.has(token) }))
            .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
    }

    async _getAssignedFilterTagTokens(docType) {
        if (this._assignedFilterTagTokenCache.has(docType)) {
            return this._assignedFilterTagTokenCache.get(docType);
        }
        if (this._assignedFilterTagTokenPromises.has(docType)) {
            return this._assignedFilterTagTokenPromises.get(docType);
        }

        const promise = (async () => {
            const tokens = new Set();
            const collect = (assets) => {
                if (!Array.isArray(assets)) return;
                for (const asset of assets) {
                    const tags = normalizeTagList(asset?.flags?.[ASSET_LIBRARIAN_FLAG_SCOPE]?.filterTag || []);
                    for (const tag of tags) tokens.add(tagToken(tag));
                }
            };

            try {
                collect(await DataManager.getAssets(docType, true));
            } catch (_err) {}
            try {
                collect(await DataManager.getAssets(docType, false));
            } catch (_err) {}

            this._assignedFilterTagTokenCache.set(docType, tokens);
            this._assignedFilterTagTokenPromises.delete(docType);
            return tokens;
        })();

        this._assignedFilterTagTokenPromises.set(docType, promise);
        return promise;
    }

    async _prepareContext(options) {
        const context = await super._prepareContext(options);
        const registry = game.settings.get("asset-librarian", ASSET_LIBRARIAN_TAG_REGISTRY_SETTING) || {};
        const config = this._getWorkingConfig();

        const sections = [];
        for (const docType of TagGroupConfigApp.DOC_TYPES) {
            const configSection = config[docType] || { groups: {} };
            const assignedTokens = await this._getAssignedFilterTagTokens(docType);
            const tags = this._getTagsForDocType(docType, registry, configSection, assignedTokens);
            const groupsObj = configSection.groups || {};
            const selectedCountByTag = new Map();

            for (const group of Object.values(groupsObj)) {
                for (const token of Object.keys(group?.tags || {})) {
                    if (!group.tags[token]) continue;
                    selectedCountByTag.set(token, (selectedCountByTag.get(token) || 0) + 1);
                }
            }

            const groups = getOrderedTagGroupsForDocType(config, docType)
                .map((groupData) => ({
                    id: groupData.id,
                    docType,
                    label: groupData.label,
                    tags: tags.map((tag) => {
                        const checked = !!groupData.tags?.[tag.token];
                        const count = selectedCountByTag.get(tag.token) || 0;
                        return {
                            ...tag,
                            checked,
                            selectedElsewhere: count - (checked ? 1 : 0) > 0,
                            isDead: tag.isDead === true
                        };
                    })
                }));

            sections.push({
                docType,
                label: game.i18n.localize(`ASSET_LIBRARIAN.Tabs.${docType}`),
                groups
            });
        }

        context.sections = sections;
        context.buttons = [
            { type: "button", action: "resetDefaults", icon: "fas fa-times", label: game.i18n.localize("ASSET_LIBRARIAN.TagGroupConfig.ResetDefaults") },
            { type: "submit", icon: "fas fa-save", label: game.i18n.localize("ASSET_LIBRARIAN.TagGroupConfig.Save") }
        ];
        return context;
    }

    _onRender(context, options) {
        super._onRender(context, options);
        this.#updateCrossGroupHighlights();
        this._crossGroupChangeHandler ??= (event) => {
            const target = event.target;
            if (!(target instanceof HTMLInputElement)) return;
            if (target.type !== "checkbox") return;
            this.#updateCrossGroupHighlights();
        };
        this.element.removeEventListener("change", this._crossGroupChangeHandler);
        this.element.addEventListener("change", this._crossGroupChangeHandler);
    }

    #updateCrossGroupHighlights() {
        const docSections = this.element.querySelectorAll("fieldset[data-doc-type]");
        for (const section of docSections) {
            const inputs = section.querySelectorAll('.compendium-list input[type="checkbox"][name*="|"]');
            const selectedCountByTag = new Map();
            for (const input of inputs) {
                const [, , token] = (input.name || "").split("|");
                if (!token) continue;
                if (input.checked) selectedCountByTag.set(token, (selectedCountByTag.get(token) || 0) + 1);
            }

            for (const input of inputs) {
                const [, , token] = (input.name || "").split("|");
                if (!token) continue;
                const row = input.closest(".compendium-item");
                if (!row) continue;
                const count = selectedCountByTag.get(token) || 0;
                const selectedElsewhere = count - (input.checked ? 1 : 0) > 0;
                row.classList.toggle("selected-elsewhere", selectedElsewhere);
            }
        }
    }

    static #newGroupId(name, existing) {
        const base = normalizeTag(name).toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "group";
        let id = base;
        let i = 2;
        while (existing[id]) {
            id = `${base}-${i}`;
            i++;
        }
        return id;
    }

    static async #onAddTagGroup(event, target) {
        const docType = target.dataset.docType;
        if (!docType) return;
        const app = this;
        app._syncWorkingConfigFromFormSelections();
        let name = null;
        try {
            name = await foundry.applications.api.DialogV2.prompt({
                window: { title: game.i18n.localize("ASSET_LIBRARIAN.TagGroupConfig.NewGroupPrompt") },
                content: `
                    <div class="form-group">
                        <label>${game.i18n.localize("ASSET_LIBRARIAN.TagGroupConfig.NewGroupPrompt")}</label>
                        <input type="text" name="name" autofocus style="width: 100%;" />
                    </div>
                `,
                ok: {
                    icon: '<i class="fas fa-check"></i>',
                    label: game.i18n.localize("ASSET_LIBRARIAN.Tagging.Add"),
                    callback: (_event, button) => button.form?.elements?.name?.value?.trim?.() || ""
                },
                cancel: {
                    icon: '<i class="fas fa-times"></i>',
                    label: game.i18n.localize("ASSET_LIBRARIAN.Tagging.Cancel")
                },
                rejectClose: false,
            });
        } catch (_err) {
            return;
        }
        if (!name) return;
        const label = normalizeTag(name);
        if (!label) return;

        const config = app._getWorkingConfig();
        config[docType] ||= { groups: {} };
        config[docType].groups ||= {};
        const groupId = TagGroupConfigApp.#newGroupId(label, config[docType].groups);
        config[docType].groups[groupId] = { label, tags: {} };
        config[docType].groupOrder ||= [];
        config[docType].groupOrder.push(groupId);
        app.render({ force: true });
    }

    static #onRemoveTagGroup(event, target) {
        const docType = target.dataset.docType;
        const groupId = target.dataset.groupId;
        if (!docType || !groupId) return;
        const app = this;
        app._syncWorkingConfigFromFormSelections();
        const config = app._getWorkingConfig();
        if (config?.[docType]?.groups?.[groupId]) {
            delete config[docType].groups[groupId];
            config[docType].groupOrder = (config[docType].groupOrder || []).filter((id) => id !== groupId);
            app.render({ force: true });
        }
    }

    static async #onRemoveDeadTag(event, target) {
        const docType = target.dataset.docType;
        const token = String(target.dataset.token || "").trim();
        if (!docType || !token) return;
        const app = this;
        app._syncWorkingConfigFromFormSelections();
        const config = app._getWorkingConfig();
        const groups = config?.[docType]?.groups || {};
        for (const groupData of Object.values(groups)) {
            if (!groupData?.tags) continue;
            delete groupData.tags[token];
        }
        const registry = foundry.utils.deepClone(
            game.settings.get("asset-librarian", ASSET_LIBRARIAN_TAG_REGISTRY_SETTING) || {},
        );
        const entry = registry?.[docType];
        if (entry?.filters) {
            entry.filters = normalizeTagList((entry.filters || []).filter((label) => tagToken(label) !== token));
            registry[docType] = entry;
            await game.settings.set("asset-librarian", ASSET_LIBRARIAN_TAG_REGISTRY_SETTING, registry);
        }
        app.render({ force: true });
    }

    static async #onSubmitForm(event, form, formData) {
        const app = this;
        const working = app._getWorkingConfig();
        const result = {};

        for (const docType of TagGroupConfigApp.DOC_TYPES) {
            const sourceGroups = working?.[docType]?.groups || {};
            const sourceOrder = Array.isArray(working?.[docType]?.groupOrder) ? working[docType].groupOrder : [];
            result[docType] = { groups: {}, groupOrder: [] };
            for (const [groupId, groupData] of Object.entries(sourceGroups)) {
                result[docType].groups[groupId] = {
                    label: groupData.label || groupId,
                    tags: {}
                };
            }
            result[docType].groupOrder = sourceOrder.filter((groupId) => !!result[docType].groups[groupId]);
            for (const groupId of Object.keys(result[docType].groups)) {
                if (!result[docType].groupOrder.includes(groupId)) result[docType].groupOrder.push(groupId);
            }
        }

        for (const [name, value] of Object.entries(formData.object)) {
            if (!value) continue;
            const [docType, groupId, token] = String(name).split("|");
            if (!docType || !groupId || !token) continue;
            if (!result[docType]?.groups?.[groupId]) continue;
            result[docType].groups[groupId].tags[token] = true;
        }

        await game.settings.set("asset-librarian", "tagGroupConfig", result);
        ui.notifications.info(game.i18n.localize("ASSET_LIBRARIAN.TagGroupConfig.Saved"));
        DataManager.invalidateCache();
        if (game.assetLibrarian?.instance?.rendered) {
            game.assetLibrarian.instance.invalidateDataCache?.();
            if (typeof game.assetLibrarian.instance.wrappedOnResetFilters === "function") {
                game.assetLibrarian.instance.wrappedOnResetFilters();
            } else {
                game.assetLibrarian.instance._lastComputedFilterStateKey = null;
            }
            game.assetLibrarian.instance.render(true);
        }
    }

    static async #onResetDefaults(event, target) {
        const confirm = await helpers.confirmationDialog(game.i18n.localize("ASSET_LIBRARIAN.TagGroupConfig.ResetConfirm"));
        if (!confirm) return;
        await game.settings.set("asset-librarian", "tagGroupConfig", {});
        this._workingConfig = null;
        this.render({ force: true });
        ui.notifications.info(game.i18n.localize("ASSET_LIBRARIAN.TagGroupConfig.ResetToDefaults"));
        DataManager.invalidateCache();
        if (game.assetLibrarian?.instance?.rendered) {
            game.assetLibrarian.instance.invalidateDataCache?.();
            game.assetLibrarian.instance._lastComputedFilterStateKey = null;
            game.assetLibrarian.instance.render(true);
        }
    }
}
