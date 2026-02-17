export const CATEGORY_GROUPS_SETTING_KEY = "customCategoryGroups";
import { DEFAULT_MAPPINGS } from "./default-mappings.js";

export const DEFAULT_CATEGORY_GROUPS = [
    "Character",
    "Abilities",
    "Background",
    "Class",
    "Feats",
    "Equipment",
    "Treasure",
    "Weapons",
    "Spells",
    "Condition",
    "All",
];

/**
 * Get system-specific categories from the current game system's default mappings.
 * These are categories defined in DEFAULT_MAPPINGS that aren't in DEFAULT_CATEGORY_GROUPS.
 * @returns {string[]} Array of system-specific category names
 */
function getSystemSpecificCategories() {
    const systemId = game?.system?.id;
    if (!systemId || !DEFAULT_MAPPINGS[systemId]) return [];

    const baseSet = new Set(DEFAULT_CATEGORY_GROUPS.map(g => g.toLowerCase()));
    const systemCategories = Object.keys(DEFAULT_MAPPINGS[systemId]);

    // Return categories from system mappings that aren't in the base defaults
    return systemCategories.filter(cat => !baseSet.has(cat.toLowerCase()));
}

const MAX_CUSTOM_GROUPS = 10;
const GROUP_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 '&/-]{1,29}$/;
const RESERVED_GROUP_NAMES = new Set(DEFAULT_CATEGORY_GROUPS.map((g) => g.toLocaleLowerCase()));

function parseCustomCategoryGroups(value) {
    const raw = typeof value === "string" ? value : "";
    const parts = raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

    const groups = [];
    const seen = new Set();
    const errors = [];

    for (const group of parts) {
        const normalizedKey = group.toLocaleLowerCase();

        if (seen.has(normalizedKey)) {
            errors.push(`duplicate:${group}`);
            continue;
        }

        if (RESERVED_GROUP_NAMES.has(normalizedKey)) {
            errors.push(`reserved:${group}`);
            continue;
        }

        if (!GROUP_NAME_PATTERN.test(group)) {
            errors.push(`invalid:${group}`);
            continue;
        }

        seen.add(normalizedKey);
        groups.push(group);

        if (groups.length >= MAX_CUSTOM_GROUPS) {
            if (parts.length > MAX_CUSTOM_GROUPS) errors.push("max");
            break;
        }
    }

    return {
        groups,
        errors,
        normalized: groups.join(", "),
    };
}

export function normalizeCustomCategoryGroupsSetting(value) {
    return parseCustomCategoryGroups(value);
}

export function getCustomCategoryGroups() {
    let raw = "";
    try {
        raw = game.settings.get("asset-librarian", CATEGORY_GROUPS_SETTING_KEY) || "";
    } catch (_err) {
        raw = "";
    }
    return parseCustomCategoryGroups(raw).groups;
}

export function getCategoryGroups() {
    const base = DEFAULT_CATEGORY_GROUPS.filter((g) => g !== "All");
    const systemSpecific = getSystemSpecificCategories();
    const custom = getCustomCategoryGroups();
    return [...base, ...systemSpecific, ...custom, "All"];
}