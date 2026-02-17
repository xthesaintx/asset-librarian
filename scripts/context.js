const getUuidFromLi = (li) => li?.dataset?.uuid;

const getDocumentFromLiSync = (li) => {
    const uuid = getUuidFromLi(li);
    if (!uuid) return null;

    if (typeof fromUuidSync === "function") {
        try {
            return fromUuidSync(uuid);
        } catch (_err) {
            return null;
        }
    }

    try {
        const parsed = foundry.utils.parseUuid(uuid);
        if (parsed?.pack) return null;
        return game.collections.get(parsed.type)?.get(parsed.id) ?? null;
    } catch (_err) {
        return null;
    }
};

const getDocumentFromLi = async (li) => {
    const uuid = getUuidFromLi(li);
    if (!uuid) return null;
    return fromUuid(uuid);
};

const getCardsType = (doc) => {
    if (!doc) return null;
    return String(doc.type ?? doc._source?.type ?? "").toLowerCase();
};

const localizeOr = (key, fallback) => {
    const localized = game.i18n.localize(key);
    return localized === key ? fallback : localized;
};

export const GET_SEND_TO_PLAYER = (app) => ({
    name: game.i18n.localize("ASSET_LIBRARIAN.Buttons.SendToPlayer"),
    icon: '<i class="fa-solid fa-user"></i>',
    condition: () => game.user.isGM,
    callback: async (li) => {
        const entry = await getDocumentFromLi(li);
        if (entry) app._onSendToPlayer(entry);
    },
});

export const GET_IMPORT_TO_WORLD = () => ({
    name: "COMPENDIUM.ImportEntry",
    icon: '<i class="fa-solid fa-download"></i>',
    condition: () => foundry.documents.Scene.canUserCreate(game.user),
    callback: async (li) => {
        const entry = await getDocumentFromLi(li);
        if (!entry || !entry.pack) return;
        const collection = game.collections.get(entry.documentName);
        collection.importFromCompendium(game.packs.get(entry.pack), entry._id, {}, { renderSheet: false });
    },
});

export const GET_EXECUTE_MACRO = () => ({
    name: "MACRO.Execute",
    icon: '<i class="fa-solid fa-play"></i>',
    condition: (li) => !!getDocumentFromLiSync(li),
    callback: async (li) => {
        const macro = await getDocumentFromLi(li);
        console.log(macro);
        await macro?.execute();
    },
});

export const GET_CONFIGURE_OWNERSHIP = () => ({
    name: "OWNERSHIP.Configure",
    icon: '<i class="fa-solid fa-lock"></i>',
    condition: () => game.user.isGM,
    callback: async (li) => {
        const document = await getDocumentFromLi(li);
        if (!document) return;
        const OwnershipConfig = foundry.applications?.apps?.DocumentOwnershipConfig;
        if (!OwnershipConfig) return;
        new OwnershipConfig({
            document,
            position: {
            },
        }).render({ force: true });
    },
});

export const GET_JUMP_TO_PIN = () => ({
    name: "SIDEBAR.JumpPin",
    icon: '<i class="fa-solid fa-crosshairs"></i>',
    condition: (li) => !!getDocumentFromLiSync(li)?.sceneNote,
    callback: async (li) => {
        const entry = await getDocumentFromLi(li);
        entry?.panToNote?.();
    },
});

export const GET_ACTOR_CHARACTER_ART = () => ({
    name: "SIDEBAR.CharArt",
    icon: '<i class="fa-solid fa-image"></i>',
    condition: (li) => {
        const actor = getDocumentFromLiSync(li);
        if (!actor) return false;
        const { img } = actor.constructor.getDefaultArtwork(actor._source);
        return actor.img !== img;
    },
    callback: async (li) => {
        const actor = await getDocumentFromLi(li);
        if (!actor) return;
        new foundry.applications.apps.ImagePopout({
            src: actor.img,
            uuid: actor.uuid,
            window: { title: actor.name },
        }).render({ force: true });
    },
});

export const GET_ACTOR_TOKEN_ART = () => ({
    name: "SIDEBAR.TokenArt",
    icon: '<i class="fa-solid fa-image"></i>',
    condition: (li) => {
        const actor = getDocumentFromLiSync(li);
        if (!actor || actor.prototypeToken?.randomImg) return false;
        const { texture } = actor.constructor.getDefaultArtwork(actor._source);
        return ![null, undefined, texture.src].includes(actor.prototypeToken?.texture?.src);
    },
    callback: async (li) => {
        const actor = await getDocumentFromLi(li);
        if (!actor) return;
        new foundry.applications.apps.ImagePopout({
            src: actor.prototypeToken?.texture?.src,
            uuid: actor.uuid,
            window: { title: actor.name },
        }).render({ force: true });
    },
});

export const GET_ITEM_VIEW_ART = () => ({
    name: "ITEM.ViewArt",
    icon: '<i class="fa-solid fa-image"></i>',
    condition: (li) => {
        const item = getDocumentFromLiSync(li);
        if (!item) return false;
        const { img } = item.constructor.getDefaultArtwork(item._source);
        return item.img !== img;
    },
    callback: async (li) => {
        const item = await getDocumentFromLi(li);
        if (!item) return;
        new foundry.applications.apps.ImagePopout({
            src: item.img,
            uuid: item.uuid,
            window: { title: item.name },
        }).render({ force: true });
    },
});

export const GET_PLAYLIST_BULK_IMPORT = () => ({
    name: "PLAYLIST.BulkImport.Title",
    icon: '<i class="fa-solid fa-files"></i>',
    callback: async (li) => {
        const playlist = await getDocumentFromLi(li);
        await playlist?.bulkImportDialog?.();
    },
});

export const GET_ROLLTABLE_DRAW_RESULT = () => ({
    name: "TABLE.ACTIONS.DrawResult",
    icon: '<i class="fa-solid fa-dice-d20"></i>',
    callback: async (li) => {
        const table = await getDocumentFromLi(li);
        table?.draw?.({ roll: true, displayChat: true });
    },
});

export const GET_CARDS_DRAW_DIALOG = () => ({
    name: localizeOr("CARDS.Draw", "Draw"),
    icon: '<i class="fa-solid fa-hand"></i>',
    condition: (li) => {
        const cards = getDocumentFromLiSync(li);
        return getCardsType(cards) === "hand";
    },
    callback: async (li) => {
        const cards = await getDocumentFromLi(li);
        await cards?.drawDialog?.();
    },
});

export const GET_CARDS_PASS_DIALOG = () => ({
    name: localizeOr("CARDS.Pass", "Pass"),
    icon: '<i class="fa-solid fa-share"></i>',
    condition: (li) => {
        const cards = getDocumentFromLiSync(li);
        const type = getCardsType(cards);
        return ["hand", "pile"].includes(type);
    },
    callback: async (li) => {
        const cards = await getDocumentFromLi(li);
        await cards?.passDialog?.();
    },
});

export const GET_CARDS_DEAL_DIALOG = () => ({
    name: localizeOr("CARDS.Deal", "Deal"),
    icon: '<i class="fa-solid fa-cards"></i>',
    condition: (li) => {
        const cards = getDocumentFromLiSync(li);
        return getCardsType(cards) === "deck";
    },
    callback: async (li) => {
        const cards = await getDocumentFromLi(li);
        await cards?.dealDialog?.();
    },
});

export const GET_CARDS_SHUFFLE = () => ({
    name: localizeOr("CARDS.Shuffle", "Shuffle"),
    icon: '<i class="fa-solid fa-shuffle"></i>',
    condition: (li) => {
        const cards = getDocumentFromLiSync(li);
        const type = getCardsType(cards);
        return ["deck", "pile"].includes(type);
    },
    callback: async (li) => {
        const cards = await getDocumentFromLi(li);
        await cards?.shuffle?.();
    },
});
