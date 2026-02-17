import {ASSET_LIBRARIAN_BASE_TABS} from './helpers.js'
export const ASSET_LIBRARIAN_FLAG_SCOPE = "asset-librarian";
export const ASSET_LIBRARIAN_TAG_REGISTRY_SETTING = "tagRegistry";

export const FLAG_TAG_TABS = ASSET_LIBRARIAN_BASE_TABS;
//["JournalEntry", "Scene", "Playlist", "Macro", "RollTable", "Cards"];

export const CATEGORY_TAG_PATH = `flags.${ASSET_LIBRARIAN_FLAG_SCOPE}.categoryTag`;
export const FILTER_TAG_PATH = `flags.${ASSET_LIBRARIAN_FLAG_SCOPE}.filterTag`;

export function supportsFlagTagsForTab(tab) {
    return FLAG_TAG_TABS.includes(tab);
}

export function normalizeTag(value) {
    if (typeof value !== "string") return "";
    return value.trim().replace(/\s+/g, " ");
}

export function tagToken(value) {
    return normalizeTag(value).toLocaleLowerCase();
}

export function normalizeTagList(raw) {
    if (raw === null || raw === undefined) return [];
    const entries = Array.isArray(raw) ? raw : String(raw).split(",");
    const out = [];
    const seen = new Set();
    for (const entry of entries) {
        const normalized = normalizeTag(entry);
        if (!normalized) continue;
        const token = tagToken(normalized);
        if (!token || seen.has(token)) continue;
        seen.add(token);
        out.push(normalized);
    }
    return out;
}

function compareTagGroupLabels(a, b) {
    return a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });
}

/**
 * Return custom tag groups in persisted order, then alphabetic fallback.
 * @param {object} tagGroupConfig
 * @param {string} docType
 * @returns {Array<{id: string, label: string, tags: object}>}
 */
export function getOrderedTagGroupsForDocType(tagGroupConfig, docType) {
    const section = tagGroupConfig?.[docType] || {};
    const groups = section?.groups || {};
    const groupOrder = Array.isArray(section?.groupOrder) ? section.groupOrder : [];
    const ids = [];
    const seen = new Set();

    for (const groupId of groupOrder) {
        if (!groups[groupId] || seen.has(groupId)) continue;
        seen.add(groupId);
        ids.push(groupId);
    }

    const remaining = Object.keys(groups)
        .filter((groupId) => !seen.has(groupId))
        .sort((leftId, rightId) => {
            const leftLabel = normalizeTag(groups[leftId]?.label || leftId);
            const rightLabel = normalizeTag(groups[rightId]?.label || rightId);
            return compareTagGroupLabels(leftLabel, rightLabel);
        });

    ids.push(...remaining);

    return ids.map((groupId) => ({
        id: groupId,
        label: normalizeTag(groups[groupId]?.label || groupId) || groupId,
        tags: groups[groupId]?.tags || {},
    }));
}
