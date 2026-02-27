import { localizeDnd5eByKey } from "./dnd5e-localization.js";
import { localizePf2eByKey } from "./pf2e-localization.js";
import { ASSET_LIBRARIAN_BASE_TABS, helpers } from "./helpers.js";
import { SYSTEM_FIELDS as FILTER_SYSTEM_FIELDS } from "./filter-system-fields.js";
import { DEFAULT_FIELDS as FILTER_DEFAULT_FIELDS } from "./filter-system-fields.js";
import { ASSET_LIBRARIAN_FLAG_SCOPE, getOrderedTagGroupsForDocType, supportsFlagTagsForTab } from "./asset-tags.js";
/**
 * FilterManager - Handles dynamic filter detection and application
 * Supports system-specific field mappings for D&D 5e, PF2e, and GURPS
 */
export class FilterManager {
    static _toFilterToken(value) {
        if (typeof value === "string") {
            const trimmed = value.trim();
            if (!trimmed) return null;
            return trimmed.toLocaleLowerCase();
        }
        if (value === null || value === undefined || value === "") return null;
        return String(value);
    }

    static _normalizeFilterEntries(rawValue) {
        if (rawValue === null || rawValue === undefined || rawValue === "") return [];

        if (rawValue instanceof Set) {
            return Array.from(rawValue).flatMap((v) => this._normalizeFilterEntries(v));
        }

        if (rawValue instanceof Map) {
            return Array.from(rawValue.keys()).flatMap((v) => this._normalizeFilterEntries(v));
        }

        if (Array.isArray(rawValue)) {
            return rawValue.flatMap((v) => this._normalizeFilterEntries(v));
        }

        if (typeof rawValue === "object") {
            
            if (typeof rawValue.valueOf === "function") {
                const primitive = rawValue.valueOf();
                if (primitive !== rawValue && (typeof primitive !== "object" || primitive === null)) {
                    return this._normalizeFilterEntries(primitive);
                }
            }

            
            if ("value" in rawValue && rawValue.value !== rawValue) {
                const normalizedValue = this._normalizeFilterEntries(rawValue.value);
                if (normalizedValue.length) return normalizedValue;
            }

            
            const preferred = rawValue.type ?? rawValue.subtype ?? rawValue.label ?? rawValue.name;
            if (preferred !== null && preferred !== undefined && preferred !== "") {
                return this._normalizeFilterEntries(preferred);
            }

            
            if (typeof rawValue.toString === "function") {
                const text = rawValue.toString();
                if (text && text !== "[object Object]") {
                    return this._normalizeFilterEntries(text);
                }
            }

            
            return [];
        }

        const display = typeof rawValue === "string" ? rawValue.trim() : String(rawValue);
        if (!display) return [];
        const token = this._toFilterToken(rawValue);
        return token ? [{ token, display }] : [];
    }

    static _normalizeFilterValues(rawValue) {
        return this._normalizeFilterEntries(rawValue).map((entry) => entry.token);
    }

    /**
     * System-specific field mappings
     * Each system has document type -> array of field paths to extract
     */
    static SYSTEM_FIELDS = FILTER_SYSTEM_FIELDS;
    static DEFAULT_FIELDS = FILTER_DEFAULT_FIELDS;
    /**
     * Get the field definitions for the current system and document type
     * Merges built-in system fields with custom user-defined fields
     * @param {string} documentType 
     * @returns {Array}
     */
    static getFieldDefinitions(documentType) {
        const systemId = game.system?.id || 'unknown';
        const systemFields = this.SYSTEM_FIELDS[systemId];

        
        let fields = [];
        if (systemFields && systemFields[documentType]) {
            fields = [...systemFields[documentType]];
        } else {
            fields = [...(this.DEFAULT_FIELDS[documentType] || [])];
        }

        
        try {
            const customFields = game.settings.get("asset-librarian", "customFilterFields") || {};
            const customDocFields = customFields[documentType] || [];
            
            for (const customField of customDocFields) {
                if (!fields.find(f => f.key === customField.key)) {
                    fields.push(customField);
                }
            }
        } catch (e) {
            
        }

        
        for (const field of fields) {
            if (field.path && !field._parsedPath) {
                field._parsedPath = this.parsePath(field.path);
            }
            if (field.path && !field._parsedSourcePath) {
                field._parsedSourcePath = this.parsePath(`_source.${field.path}`);
            }
        }

        if (supportsFlagTagsForTab(documentType)) {
            const config = game.settings.get("asset-librarian", "tagGroupConfig") || {};
            const orderedGroups = getOrderedTagGroupsForDocType(config, documentType);
            for (const groupData of orderedGroups) {
                const groupId = groupData.id;
                const tokenSet = new Set(Object.keys(groupData?.tags || {}).filter((t) => groupData.tags[t]));
                if (!tokenSet.size) continue;
                const key = `filterTagGroup:${documentType}:${groupId}`;
                if (fields.some((f) => f.key === key)) continue;
                const label = groupData?.label || groupId;
                fields.push({
                    key,
                    label,
                    getValue: (asset) => {
                        const raw = asset?.flags?.[ASSET_LIBRARIAN_FLAG_SCOPE]?.filterTag || [];
                        const entries = FilterManager._normalizeFilterEntries(raw);
                        return entries.filter((e) => tokenSet.has(e.token)).map((e) => e.display);
                    },
                    isArray: true
                });
            }

            if (!fields.some((f) => f.key === "filterTag")) {
                const path = `flags["asset-librarian"].filterTag`;
                fields.push({
                    key: "filterTag",
                    label: "Tags",
                    path,
                    _parsedPath: this.parsePath(path),
                    _parsedSourcePath: this.parsePath(`_source.${path}`),
                });
            }
        }
        return fields;
    }


    /**
     * Parse a path string into an array of parts, handling dot and bracket notation.
     * @param {string} path 
     * @returns {string[]}
     */
    static parsePath(path) {
        if (!path) return [];
        const parts = [];
        let current = '';
        let inBracket = false;
        let bracketQuote = null;

        for (let i = 0; i < path.length; i++) {
            const char = path[i];

            if (inBracket) {
                if (char === bracketQuote) {
                    bracketQuote = null;
                } else if (char === ']' && !bracketQuote) {
                    parts.push(current);
                    current = '';
                    inBracket = false;
                } else {
                    current += char;
                }
            } else if (char === '[') {
                if (current) parts.push(current);
                current = '';
                inBracket = true;
                const nextChar = path[i + 1];
                if (nextChar === '"' || nextChar === "'") {
                    bracketQuote = nextChar;
                    i++;
                }
            } else if (char === '.') {
                if (current) parts.push(current);
                current = '';
            } else {
                current += char;
            }
        }
        if (current) parts.push(current);
        return parts;
    }

    /**
     * Get a nested value from an object using dot notation path
     * Supports bracket notation for special keys: flags["campaign-codex"].type
     * @param {Object} obj 
     * @param {string} path 
     * @returns {*}
     */
    static getNestedValue(obj, pathOrParts) {
        if (!obj || !pathOrParts) return undefined;
        const parts = Array.isArray(pathOrParts) ? pathOrParts : this.parsePath(pathOrParts);

        let values = [obj];
        for (const part of parts) {
            const nextValues = [];
            const isNumericIndex = /^\d+$/.test(part);

            for (const value of values) {
                if (value === null || value === undefined) continue;

                if (Array.isArray(value)) {
                    if (isNumericIndex) {
                        const idxValue = value[Number(part)];
                        if (idxValue !== undefined) nextValues.push(idxValue);
                        continue;
                    }

                    for (const item of value) {
                        if (item === null || item === undefined) continue;
                        const itemValue = item?.[part];
                        if (itemValue !== undefined) nextValues.push(itemValue);
                    }
                    continue;
                }

                const directValue = value[part];
                if (directValue !== undefined) nextValues.push(directValue);
            }

            if (!nextValues.length) return undefined;
            values = nextValues;
        }

        return values.length === 1 ? values[0] : values;
    }

    /**
     * Build filter options by scanning assets
     * @param {Array} assets - The assets to scan
     * @param {string} documentType - Actor, Item, etc.
     * @returns {Array} Array of filter groups with values and counts
     */
    static buildFilters(assets, documentType) {
        const fieldDefs = this.getFieldDefinitions(documentType);
        if (!fieldDefs.length || !assets.length) return [];

        const filters = [];

        for (const fieldDef of fieldDefs) {
            const filter = this._buildFilterFromFieldDef(assets, fieldDef);
            if (filter) filters.push(filter);
        }

        return filters;
    }

    /**
     * Build one filter group for a specific key.
     * @param {Array} assets
     * @param {string} documentType
     * @param {string} filterKey
     * @returns {Object|null}
     */
    static buildFilterGroup(assets, documentType, filterKey) {
        if (!assets.length) return null;
        const fieldDef = this.getFieldDefinitions(documentType).find((f) => f.key === filterKey);
        if (!fieldDef) return null;
        return this._buildFilterFromFieldDef(assets, fieldDef);
    }

    /**
     * Build one filter group from a field definition.
     * @param {Array} assets
     * @param {Object} fieldDef
     * @returns {Object|null}
     */
    static _buildFilterFromFieldDef(assets, fieldDef) {
        const valueCounts = new Map();
        const displayByToken = new Map();

        for (const asset of assets) {
            let value;
            if (typeof fieldDef.getValue === "function") {
                value = fieldDef.getValue(asset);
            } else {
                value = this.getNestedValue(asset, fieldDef._parsedPath);
                if (value === undefined) {
                    value = this.getNestedValue(asset, fieldDef._parsedSourcePath);
                }
            }

            const normalizedEntries = this._normalizeFilterEntries(value);
            for (const entry of normalizedEntries) {
                const count = valueCounts.get(entry.token) || 0;
                valueCounts.set(entry.token, count + 1);
                if (!displayByToken.has(entry.token)) {
                    displayByToken.set(entry.token, entry.display);
                }
            }
        }

        if (!valueCounts.size) return null;

        const values = Array.from(valueCounts.entries())
            .map(([value, count]) => ({
                value,
                label: this.formatLabel(displayByToken.get(value) ?? value, fieldDef.key),
                count,
                state: "off", 
            }))
            .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: "base" }));

        return {
            key: fieldDef.key,
            label: fieldDef.label,
            path: fieldDef.path,
            getValue: fieldDef.getValue,
            isArray: fieldDef.isArray || false,
            values,
        };
    }

    /**
     * Format a value for display
     * Checks game system configs for localized labels (e.g., DND5e itemProperties)
     * @param {string} value 
     * @param {string} filterKey
     * @returns {string}
     */
    static formatLabel(value, filterKey) {
        if (!value) return 'Unknown';

        const strValue = String(value);
        const normalizedValue = strValue.trim().toLocaleLowerCase();

        if (filterKey === "codexType") {
            if (normalizedValue === "shop") return "Entry";
            if (normalizedValue === "tag") return "Faction";
        }

        let localized;

        if (game.system?.id == "dnd5e"){
             localized = localizeDnd5eByKey(strValue, {
              preferredMapKeys: ["weaponTypes"] 
            });

        } else if (game.system?.id == "pf2e"){
             localized = localizePf2eByKey(strValue, {
              preferredMapKeys: ["weaponCategories"] 
            });            
        }
        if (localized) return localized;

        
        return strValue
            .replace(/([a-z])([A-Z])/g, '$1 $2')
            .replace(/_/g, ' ')
            .replace(/\b\w/g, c => c.toUpperCase());
    }

    /**
     * Apply active filters to asset list
     * Logic: AND between different filter groups, OR within the same group
     * States: 'off' (no filter), 'include' (OR match), 'and' (must include), 'exclude' (must not match)
     * @param {Array} assets 
     * @param {Array} filters - Filter definitions with state
     * @returns {Array} Filtered assets
     */
    static applyFilters(assets, filters) {
        
        const activeFilters = filters.filter(f =>
            f.values.some(v => v.state === 'include' || v.state === 'and' || v.state === 'exclude')
        );

        if (!activeFilters.length) return assets;

        const preparedFilters = activeFilters.map((filter) => {
            const includeValues = new Set(
                filter.values
                    .filter((v) => v.state === "include")
                    .map((v) => this._toFilterToken(v.value))
                    .filter((v) => v !== null),
            );
            const andValues = new Set(
                filter.values
                    .filter((v) => v.state === "and")
                    .map((v) => this._toFilterToken(v.value))
                    .filter((v) => v !== null),
            );            
            const excludeValues = new Set(
                filter.values
                    .filter((v) => v.state === "exclude")
                    .map((v) => this._toFilterToken(v.value))
                    .filter((v) => v !== null),
            );

            if (typeof filter.getValue !== "function") {
                if (!filter._parsedPath) filter._parsedPath = this.parsePath(filter.path);
                if (!filter._parsedSourcePath) filter._parsedSourcePath = this.parsePath(`_source.${filter.path}`);
            }

            return { filter, includeValues, andValues, excludeValues };
        });

        return assets.filter(asset => {
            
            for (const { filter, includeValues, andValues, excludeValues } of preparedFilters) {

                let assetValue;

                
                if (typeof filter.getValue === 'function') {
                    assetValue = filter.getValue(asset);
                } else {
                    
                    assetValue = this.getNestedValue(asset, filter._parsedPath);
                    if (assetValue === undefined) {
                        assetValue = this.getNestedValue(asset, filter._parsedSourcePath);
                    }
                }

                const assetValues = this._normalizeFilterValues(assetValue);

                
                for (const av of assetValues) {
                    if (excludeValues.has(av)) {
                        return false;
                    }
                }

                if (andValues.size > 0) {
                    for (const required of andValues) {
                        if (!assetValues.includes(required)) {
                            return false;
                        }
                    }
                }
                if (includeValues.size > 0) {
                    const hasIncludeMatch = assetValues.some(av => includeValues.has(av));
                    if (!hasIncludeMatch) {
                        return false;
                    }
                }
            }
            
            return true;
        });
    }
}
