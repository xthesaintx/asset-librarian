/**
 * Ordered DND5E config maps to check for key-based localization.
 * Keep this order intentional to reduce ambiguous matches.
 */
export const DND5E_LOCALIZATION_MAP_KEYS = [
  "abilities",
  "abilityActivationTypes",
  // "abilityConsumptionTypes",
  // "activityActivationTypes",
  // "activityConsumptionTypes",
  // "activityTypes",
  "actorSizes",
  // "advancementTypes",
  // "alignments",
  // "areaTargetTypes",
  // "armorClasses",
  // "armorProficiencies",
  "armorTypes",
  // "attackClassifications",
  // "attackModes",
  "attackTypes",
  "attunementTypes",
  // "communicationTypes",
  "conditionTypes",
  "consumableTypes",
  "containerTypes",
  // "cover",
  "creatureTypes",
  // "currencies",
  "damageTypes",
  // "distanceUnits",
  // "equipmentTypes",
  // "featureTypes",
  // "focusTypes",
  // "groupTypes",
  "habitats",
  // "healingTypes",
  // "individualTargetTypes",
  // "itemActionTypes",
  // "itemCapacityTypes",
  "itemProperties",
  "itemRarity",
  // "languages",
  // "limitedUsePeriods",
  // "lootTypes",
  // "miscEquipmentTypes",
  // "movementTypes",
  // "movementUnits",
  // "proficiencyLevels",
  // "rangeTypes",
  // "restTypes",
  // "ruleTypes",
  // "senses",
  "sourceBooks",
  // "spellLevels",
  // "spellListTypes",
  // "spellPreparationStates",
  // "spellProgression",
  // "spellScalingModes",
  "spellSchools",
  // "staticAbilityActivationTypes",
  // "targetTypes",
  // "themes",
  // "timePeriods",
  // "timeUnits",
  // "toolProficiencies",
  // "toolTypes",
  // "tools",
  // "traits",
  // "travelTypes",
  // "travelUnits",
  // "treasure",
  // "vehicleTypes",
  // "volumeUnits",
  "weaponMasteries",
  // "weaponProficiencies",
  "weaponTypes",
  // "weightUnits"
];

/**
 * Resolve a dnd5e label from CONFIG.DND5E by key.
 * Returns null when not found or ambiguous.
 */
export function localizeDnd5eByKey(strValue, {
  preferredMapKeys = [],
  mapKeys = DND5E_LOCALIZATION_MAP_KEYS
} = {}) {
  if (game.system?.id !== "dnd5e" || !CONFIG?.DND5E || !strValue) return null;

  const checkMaps = [...preferredMapKeys, ...mapKeys.filter(k => !preferredMapKeys.includes(k))];
  const hits = [];

  for (const mapKey of checkMaps) {
    const map = CONFIG.DND5E?.[mapKey];
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
  const uniqueLabels = [...new Set(hits.map(h => h.label))];
  if (uniqueLabels.length !== 1) return null;

  return game.i18n.localize(uniqueLabels[0]);
}
