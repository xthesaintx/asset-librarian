/**
 * Ordered PF2E config maps to check for key-based localization.
 * Keep this order intentional to reduce ambiguous matches.
 */
export const PF2E_LOCALIZATION_MAP_KEYS = [
  "actorSizes",
  "actorTypes",
  "rarityTraits",
  "skills",

  "actionTraits",
  "ancestryTraits",
  "armorTraits",
  "classTraits",
  "consumableTraits",
  "creatureTraits",
  "damageTraits",
  "effectTraits",
  "elementTraits",
  "equipmentTraits",
  "featTraits",
  "hazardTraits",
  "kingmakerTraits",
  "shieldTraits",
  "spellTraits",
  "vehicleTraits",
  // "traitsDescriptions",

  "baseArmorTypes",
  "baseShieldTypes",
  "baseWeaponTypes",

  "Actor",
  "Canvas",
  "Item",
  "JournalEntry",
  // "SETTINGS",
  "abilities",
  "accessoryPropertyRunes",
  "actionCategories",

  "actionTypes",
  // "actionsNumber",
  "ammoTypes",

  "armorCategories",
  "armorGroups",
  "armorImprovements",

  "attackEffects",
  "attitude",
  "chatDamageButtonShieldToggle",
  "checkDCs",

  "conditionTypes",
  "consumableCategories",

  "creatureTypes",
  "currencies",
  "damageCategories",
  // "damageDice",
  // "damageDie",
  "damageRollFlavors",

  "damageTypes",
  "dcAdjustments",
  "defaultPartyId",
  "deityDomains",

  "energyDamageTypes",
  "environmentFeatures",
  "environmentTypes",

  "equivalentWeapons",
  "featCategories",

  "frequencies",
  "grades",

  "hexplorationActivities",
  "identification",
  "immunityTypes",
  // "itemBonuses",

  "languages",
  // "levels",
  "magicTraditions",
  "materialDamageEffects",
  "meleeWeaponGroups",
  "npcAttackTraits",
  "otherArmorTags",
  "otherConsumableTags",
  "otherWeaponTags",
  "pfsFactions",
  "pfsSchools",
  "physicalDamageTypes",
  "preciousMaterialGrades",
  "preciousMaterials",
  "preparationType",
  "prerequisitePlaceholders",
  // "proficiencyLevels",
  "proficiencyRanks",
  "resistanceTypes",
  "saves",
  "savingThrowDefaultAttributes",
  "senseAcuities",
  "senses",
  "shieldImprovements",

  "spellcastingItems",
  "stackGroups",
  "statusEffects",
  "thrownBaseWeapons",
  // "timeUnits",
  "usages",

  "weaknessTypes",
  "weaponCategories",
  "weaponDescriptions",
  "weaponGroups",
  // "weaponHands",
  "weaponImprovements",
  // "weaponMAP",
  // "weaponReload",
  "weaponTraits",
  // "worldClock"
];

/**
 * Resolve a pf2e label from CONFIG.PF2E by key.
 * Returns null when not found or ambiguous.
 */
export function localizePf2eByKey(strValue, { preferredMapKeys = [], mapKeys = PF2E_LOCALIZATION_MAP_KEYS } = {}) {
  if (game.system?.id !== "pf2e" || !CONFIG?.PF2E || !strValue) return null;

  const checkMaps = [...preferredMapKeys, ...mapKeys.filter((k) => !preferredMapKeys.includes(k))];
  const hits = [];

  for (const mapKey of checkMaps) {
    const map = CONFIG.PF2E?.[mapKey];
    if (!map || typeof map !== "object" || Array.isArray(map)) continue;
    if (!(strValue in map)) continue;

    const found = map[strValue];
    let label = null;

    if (typeof found === "string") label = found;
    else if (found && typeof found === "object") {
      if (typeof found.label === "string") label = found.label;
      else if (typeof found.value === "string") label = found.value;
      else if (typeof found.name === "string") label = found.name;
    }

    if (label) hits.push({ mapKey, label });
  }

  if (!hits.length) return null;

  // If multiple different labels found, treat as ambiguous.
  const uniqueLabels = [...new Set(hits.map((h) => h.label))];
  if (uniqueLabels.length !== 1) return null;

  return game.i18n.localize(uniqueLabels[0]);
}