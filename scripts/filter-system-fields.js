    export const DEFAULT_FIELDS = {
        Item: [{ key: 'type', label: 'Type', path: 'type' }],
        Actor: [{ key: 'type', label: 'Type', path: 'type' }],
        JournalEntry: [
            { key: 'pages', label: 'Has Pages', path: '_hasPages' },
            { key: 'codexType', label: 'Campaign Codex', path: 'flags["campaign-codex"].type' },
            { key: 'sheetClass', label: 'Sheet Type', path: '_sheetClass' }
        ],
        Scene: [
            { key: 'navigation', label: 'In Navigation', path: 'navigation' },
            { key: 'active', label: 'Active', path: 'active' },
            { key: 'weather', label: 'Weather', path: 'weather' }
        ],
        RollTable: [
            { key: 'formula', label: 'Formula', path: 'formula' },
            { key: 'displayRoll', label: 'Display Roll', path: 'displayRoll' },
        ],
        Cards: [
            { key: 'type', label: 'Type', path: 'type' },
        ],
        Macro: [
            { key: 'type', label: 'Type', path: 'type' },
        ],
        Playlist: [
            { key: 'channel', label: 'Channel', path: 'channel' },
        ],
        Image: [
            { key: 'extension', label: 'Extension', path: 'extension' },
        ]        
    };


    export const SYSTEM_FIELDS = {
        dnd5e: {
            Item: [
                { key: 'type', label: 'Type', path: 'type' },
                { key: 'category', label: 'Category', path: 'system.type.value'},
                { key: 'subtype', label: 'Subtype', path: 'system.type.subtype' },
                { key: 'rarity', label: 'Rarity', path: 'system.rarity' },
                // SPELLS
                { key: 'level', label: 'Spell Level', path: 'system.level' },
                { key: 'school', label: 'School', path: 'system.school' },
                { key: 'activation', label: 'Activation', path: 'system.activation.type' },
                { key: 'spelllist', label: 'Spell List', path: 'spellList' },
                // 
                { key: 'mastery', label: 'Weapon mastery', path: 'system.mastery' },
                { key: 'armorType', label: 'Armor Type', path: 'system.armor.type' },
                { key: 'properties', label: 'Properties', path: 'system.properties' },
                // Species
                { key: 'sensesLabel', label: 'Senses', path: 'system.sensesLabels'},
                { key: 'darkvision', label: 'Has Darkvision', path: 'system.senses.darkvision'},
                // Class
                { key: 'subclass', label: 'Origin Class', path: 'system.classIdentifier'},
                { key: 'spellcasting', label: 'Has Spellcasting', path: 'system.spellcasting.progression'},
                // Features
                { key: 'advancement', label: 'Advancement', path: 'system.advancement.type'},
                { key: 'asi', label: 'ASI', path: 'system.advancement.configuration.locked'},

                // Footer
                { key: 'attunement', label: 'Attunement', path: 'system.attunement' },
                { key: 'book', label: 'Source', path: 'system.source.book' },
            ],
            Actor: [
                { key: 'type', label: 'Type', path: 'type' },
                { key: 'cr', label: 'CR', path: 'system.details.cr' },
                { key: 'size', label: 'Size', path: 'system.traits.size' },
                { key: 'habitat', label: 'Habitat', path: 'system.details.habitat.value[type]' },
                { key: 'creatureType', label: 'Creature Type', path: 'system.details.type.value' },
                { key: 'book', label: 'Source', path: 'system.source.book' }
            ],
            JournalEntry: [
                { key: 'codexType', label: 'Campaign Codex', path: 'flags["campaign-codex"].type' },
                { key: 'collectionName', label: 'Collection', path: 'collectionName' },
                { key: 'sheetClass', label: 'Sheet Type', path: '_sheetClass' }
            ]
        },
        pf2e: {
            Item: [
                { key: 'type', label: 'Type', path: 'type' },
                { key: 'actionType', label: 'Action Type', path: 'system.actionType.value' },
                { key: 'actions', label: 'Actions', path: 'system.actions.value' },
                { key: 'group', label: 'Group', path: 'system.group' },
                { key: 'category', label: 'Category', path: 'system.category' },
                { key: 'level', label: 'Level', path: 'system.level.value' },
                { key: 'traditions', label: 'Traditions', path: 'system.traits.traditions' },

                { key: 'rarity', label: 'Rarity', path: 'system.traits.rarity' },
                { key: 'keyability', label: 'Key Ability', path: 'system.keyAbility.value' },
                { key: 'trainedSkills', label: 'Trained Skills', path: 'system.trainedSkills.value' },
                { key: 'boosts', label: 'Boosts', path: 'system.boosts[0]' },

                // long
                { key: 'baseItem', label: 'Base Item', path: 'system.baseItem' },

                { key: 'traits', label: 'traits', path: 'system.traits.value' },

                // { key: 'traits', label: 'Traits', path: 'system.traits.value' },
                { key: 'source', label: 'Source', path: 'system.publication.title' }

            ],
            Actor: [
                { key: 'type', label: 'Type', path: 'type' },
                { key: 'level', label: 'Level', path: 'system.details.level.value' },
                { key: 'rarity', label: 'Rarity', path: 'system.traits.rarity' },
                { key: 'size', label: 'Size', path: 'system.traits.size.value' },
                { key: 'traits', label: 'traits', path: 'system.traits.value' },
            ],
            JournalEntry: [
                { key: 'codexType', label: 'Campaign Codex', path: 'flags["campaign-codex"].type' },
                { key: 'sheetClass', label: 'Sheet Type', path: '_sheetClass' }
            ]
        },
        gurps: { 
            Item: [
                { key: 'type', label: 'Type', path: 'type' },
                { key: 'categories', label: 'Eqt Categories', path: 'system.eqt.categories' },
                { key: 'cost', label: 'Eqt Cost', path: 'system.eqt.cost' },
                { key: 'techlevel', label: 'Eqt Techlevel', path: 'system.eqt.techlevel' },
                { key: 'spells', label: 'Spells', path: 'system.spells' },
                { key: 'skills', label: 'Skills', path: 'system.skills' },
                { key: 'melee', label: 'Melee', path: 'system.melee' },
                { key: 'ranged', label: 'Ranged', path: 'system.ranged' },
                { key: 'bonuses', label: 'Bonuses', path: 'system.bonuses' },
                { key: 'legalityclass', label: 'Eqt Legalityclass', path: 'system.eqt.legalityclass' },
            ],
            Actor: [
                { key: 'type', label: 'Type', path: 'type' }
            ],
            JournalEntry: [
                { key: 'codexType', label: 'Campaign Codex', path: 'flags["campaign-codex"].type' },
                { key: 'sheetClass', label: 'Sheet Type', path: '_sheetClass' }
            ]
        },
        daggerheart: {
            Item: [
                { key: 'type', label: 'Type', path: 'type' },
                { key: 'tier', label: 'Tier', path: 'system.tier' },
                { key: 'type', label: 'Category', path: 'system.type' },
                { key: 'beastformType', label: 'Beastform Type', path: 'system.beastformType' },
                { key: 'mainTrait', label: 'Main Trait', path: 'system.mainTrait' },
                { key: 'domain', label: 'Domain', path: 'system.domain' },
                { key: 'level', label: 'Level', path: 'system.level' },
                { key: 'recallCost', label: 'Recall Cost', path: 'system.recallCost' },
                { key: 'originItemType', label: 'Origin Item Type', path: 'system.originItemType' },
                { key: 'resource', label: 'Resource', path: 'system.resource' },
                { key: 'domains', label: 'Domains', path: 'system.domains' },
                { key: 'spellcastingTrait', label: 'Spellcasting Trait', path: 'system.spellcastingTrait' },
                { key: 'armorFeatures', label: 'Armor Features', path: 'system.armorFeatures' },
                { key: 'major', label: 'Base Major', path: 'system.baseThresholds.major' },
                { key: 'severe', label: 'Base Severe', path: 'system.baseThresholds.severe' },
                { key: 'consumeOnUse', label: 'Consume On Use', path: 'system.consumeOnUse' },
                { key: 'burden', label: 'Burden', path: 'system.burden' },
                { key: 'range', label: 'Attack Range', path: 'system.attack.range' },

            ],
            Actor: [
                { key: 'type', label: 'Type', path: 'type' },
                { key: 'difficulty', label: 'Difficulty', path: 'system.difficulty' },
                { key: 'tier', label: 'Tier', path: 'system.tier' },
                { key: 'type', label: 'Category', path: 'system.type' },
                { key: 'major', label: 'Major', path: 'system.damageThresholds.major' },
                { key: 'severe', label: 'Severe', path: 'system.damageThresholds.severe' },
                { key: 'immunity', label: 'Magical  Immunity', path: 'system.resistance.magical.immunity' },
                { key: 'resistance', label: 'Magical Resistance', path: 'system.resistance.magical.resistance' },
                { key: 'immunity', label: 'Physical Immunity', path: 'system.resistance.physical.immunity' },
                { key: 'immunity', label: 'Physical Resistance', path: 'system.resistance.physical.Resistance' },
            ],
            JournalEntry: [
                { key: 'codexType', label: 'Campaign Codex', path: 'flags["campaign-codex"].type' },
                { key: 'sheetClass', label: 'Sheet Type', path: '_sheetClass' }
            ]
        },
        shadowdark: {
            Item: [
                { key: 'type', label: 'Type', path: 'type' },
                { key: 'magicItem', label: 'Magic Item', path: 'system.magicItem' },
                { key: 'bonuses', label: 'Bonuses', path: 'system.bonuses' },
                { key: 'talentClass', label: 'Talent Class', path: 'system.talentClass' },
                { key: 'source', label: 'Source', path: 'system.source.title' },
            ],
            Actor: [
                { key: 'type', label: 'Type', path: 'type' },
                { key: 'move', label: 'Move', path: 'system.move' },
                { key: 'moveNote', label: 'Move Note', path: 'system.note' },
                { key: 'level', label: 'Level', path: 'system.level.value' },
                { key: 'hp', label: 'HP', path: 'system.attributes.hp.value' },
                { key: 'ac', label: 'AC', path: 'system.attributes.ac.value' },
                { key: 'spellcastingAbility', label: 'Spellcasting Ability', path: 'system.spellcastingAbility' },
            ],
            JournalEntry: [
                { key: 'codexType', label: 'Campaign Codex', path: 'flags["campaign-codex"].type' },
                { key: 'sheetClass', label: 'Sheet Type', path: '_sheetClass' }
            ]
        },
        swade: {
            Item: [
                { key: 'type', label: 'Type', path: 'type' },
                { key: 'subtype', label: 'Subtype', path: 'system.subtype' },
                { key: 'price', label: 'Price', path: 'system.price' },
                { key: 'category', label: 'Category', path: 'system.category' },
                { key: 'attribute', label: 'Attribute', path: 'system.attribute' },
                { key: 'isArcaneBackground', label: 'Is Arcane Background', path: 'system.isArcaneBackground' },
                { key: 'duration', label: 'Duration', path: 'system.duration' },
                { key: 'arcane', label: 'Arcane', path: 'system.arcane' },
                { key: 'range', label: 'Range', path: 'system.range' },
                { key: 'rank', label: 'Rank', path: 'system.rank' },
            ],
            Actor: [
                { key: 'type', label: 'Type', path: 'type' },
                { key: 'mode', label: 'Advances Mode', path: 'system.advances.mode' },
                { key: 'rank', label: 'Advances Rank', path: 'system.advances.rank' },
                { key: 'name', label: 'Species Name', path: 'system.details.species.name' },
                { key: 'archetype', label: 'Archetype', path: 'system.details.archetype' },
                { key: 'wildcard', label: 'Wildcard', path: 'system.wildcard' },
                { key: 'category', label: 'Category', path: 'system.category' },            ],
            JournalEntry: [
                { key: 'codexType', label: 'Campaign Codex', path: 'flags["campaign-codex"].type' },
                { key: 'sheetClass', label: 'Sheet Type', path: '_sheetClass' }
            ]
        }
    };