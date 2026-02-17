import { CompendiumSelectorApp, CustomFilterFieldsApp, CategoryConfigApp, TagGroupConfigApp } from './settings-apps.js';
import { ASSET_LIBRARIAN_BASE_TABS, helpers } from "./helpers.js";
import { CATEGORY_GROUPS_SETTING_KEY, normalizeCustomCategoryGroupsSetting } from "./category-groups.js";
import { ASSET_LIBRARIAN_TAG_REGISTRY_SETTING } from "./asset-tags.js";

export const registerSettings = function () {
  game.settings.register("asset-librarian", "showWelcomeMessage", {
    name: "ASSET_LIBRARIAN.Settings.ShowWelcomeMessage.Name",
    hint: "ASSET_LIBRARIAN.Settings.ShowWelcomeMessage.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });


  game.settings.register("asset-librarian", CATEGORY_GROUPS_SETTING_KEY, {
    name: "ASSET_LIBRARIAN.Settings.CustomCategoryGroups.Name",
    hint: "ASSET_LIBRARIAN.Settings.CustomCategoryGroups.Hint",
    scope: "world",
    config: true,
    type: String,
    default: "",
    onChange: async (value) => {
      const { normalized, errors } = normalizeCustomCategoryGroupsSetting(value);

      if (errors.length) {
        ui.notifications.warn(game.i18n.localize("ASSET_LIBRARIAN.CategoryConfig.CustomGroupsValidationWarning"));
      }

      if (value !== normalized) {
        await game.settings.set("asset-librarian", CATEGORY_GROUPS_SETTING_KEY, normalized);
        return;
      }

      if (game.assetLibrarian?.instance?.rendered) {
        game.assetLibrarian.instance.render(true);
      }
    }
  });


  game.settings.register("asset-librarian", "lastWelcomeVersion", {
    name: "ASSET_LIBRARIAN.Settings.LastWelcomeVersion.Name",
    hint: "ASSET_LIBRARIAN.Settings.LastWelcomeVersion.Hint",
    scope: "world",
    config: false,
    type: String,
    default: ""
  });
  game.settings.register("asset-librarian", "debugCacheLogs", {
    name: "ASSET_LIBRARIAN.Settings.DebugCacheLogs.Name",
    hint: "ASSET_LIBRARIAN.Settings.DebugCacheLogs.Hint",
    scope: "client",
    config: false,
    type: Boolean,
    default: false
  });

  for (const type of ASSET_LIBRARIAN_BASE_TABS) {
    game.settings.register("asset-librarian", `showTab${type}`, {
      name: `ASSET_LIBRARIAN.Settings.ShowTab.${type}.Name`,
      hint: `ASSET_LIBRARIAN.Settings.ShowTab.${type}.Hint`,
      scope: "world",
      config: true,
      type: Boolean,
      default: true,
      onChange: () => { if (game.assetLibrarian.instance?.rendered) game.assetLibrarian.instance.render();}
    });
  }

  game.settings.register("asset-librarian", "includedCompendiums", {
    name: "ASSET_LIBRARIAN.Settings.IncludedCompendiums.Name",
    hint: "ASSET_LIBRARIAN.Settings.IncludedCompendiums.Hint",
    scope: "world",
    config: false,
    type: Object,
    default: {}
  });

  game.settings.register("asset-librarian", "includeWorld", {
    name: "ASSET_LIBRARIAN.Settings.IncludeWorld.Name",
    hint: "ASSET_LIBRARIAN.Settings.IncludeWorld.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register("asset-librarian", "allowPlayersSceneControl", {
    name: "ASSET_LIBRARIAN.Settings.AllowPlayersSceneControl.Name",
    hint: "ASSET_LIBRARIAN.Settings.AllowPlayersSceneControl.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });
  game.settings.register("asset-librarian", "enableImageScanning", {
    name: "ASSET_LIBRARIAN.Settings.EnableImageScanning.Name",
    hint: "ASSET_LIBRARIAN.Settings.EnableImageScanning.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });

  game.settings.register("asset-librarian", "includeWorldPath", {
    name: "ASSET_LIBRARIAN.Settings.IncludeWorldPath.Name",
    hint: "ASSET_LIBRARIAN.Settings.IncludeWorldPath.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register("asset-librarian", "filterCollapsed", {
    name: "ASSET_LIBRARIAN.Settings.FilterCollapsed.Name",
    hint: "ASSET_LIBRARIAN.Settings.FilterCollapsed.Hint",
    scope: "world",
    config: false,
    type: Boolean,
    default: true
  });

  game.settings.register("asset-librarian", "folderCollapsed", {
    name: "ASSET_LIBRARIAN.Settings.FolderCollapsed.Name",
    hint: "ASSET_LIBRARIAN.Settings.FolderCollapsed.Hint",
    scope: "world",
    config: false,
    type: Boolean,
    default: true
  });
  game.settings.register("asset-librarian", "showNestedFolderContent", {
    name: "ASSET_LIBRARIAN.Settings.ShowNestedFolderContent.Name",
    hint: "ASSET_LIBRARIAN.Settings.ShowNestedFolderContent.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });

  game.settings.register("asset-librarian", "imageScanPaths", {
    name: "ASSET_LIBRARIAN.Settings.ImageScanPaths.Name",
    hint: "ASSET_LIBRARIAN.Settings.ImageScanPaths.Hint",
    scope: "world",
    config: false,
    type: Object,
    default: []
  });

  game.settings.register("asset-librarian", "viewMode", {
    name: "ASSET_LIBRARIAN.Settings.ViewMode.Name",
    hint: "ASSET_LIBRARIAN.Settings.ViewMode.Hint",
    scope: "client",
    config: false,
    type: String,
    default: "large"
  });

  game.settings.register("asset-librarian", "defaultTab", {
    scope: "client",
    config: false,
    type: String,
    default: ""
  });
  game.settings.register("asset-librarian", "defaultTabWorld", {
    scope: "client",
    config: false,
    type: String,
    default: ""
  });
  game.settings.register("asset-librarian", "defaultTabCompendium", {
    scope: "client",
    config: false,
    type: String,
    default: ""
  });
  game.settings.register("asset-librarian", "defaultOpenView", {
    scope: "client",
    config: false,
    type: String,
    default: ""
  });
  game.settings.register("asset-librarian", "lastOpenView", {
    scope: "client",
    config: false,
    type: String,
    default: ""
  });
  game.settings.register("asset-librarian", "thumbnailCacheMap", {
    scope: "world",
    config: false,
    type: Object,
    default: {}
  });

  game.settings.register("asset-librarian", "useDiskThumbnailCache", {
    name: "ASSET_LIBRARIAN.Settings.UseDiskThumbnailCache.Name",
    hint: "ASSET_LIBRARIAN.Settings.UseDiskThumbnailCache.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register("asset-librarian", "scenePreviewCacheMap", {
    scope: "world",
    config: false,
    type: Object,
    default: {}
  });

  game.settings.register("asset-librarian", "useDiskScenePreviewCache", {
    name: "ASSET_LIBRARIAN.Settings.UseDiskScenePreviewCache.Name",
    hint: "ASSET_LIBRARIAN.Settings.UseDiskScenePreviewCache.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register("asset-librarian", "customFilterFields", {
    name: "ASSET_LIBRARIAN.Settings.CustomFilterFields.Name",
    hint: "ASSET_LIBRARIAN.Settings.CustomFilterFields.Hint",
    scope: "world",
    config: false,
    type: Object,
    default: {}
  });

  game.settings.register("asset-librarian", "categoryConfig", {
    name: "ASSET_LIBRARIAN.Settings.CategoryConfig.Name",
    hint: "ASSET_LIBRARIAN.Settings.CategoryConfig.Hint",
    scope: "world",
    config: false,
    type: Object,
    default: {}
  });

  game.settings.register("asset-librarian", ASSET_LIBRARIAN_TAG_REGISTRY_SETTING, {
    name: "ASSET_LIBRARIAN.Settings.TagRegistry.Name",
    hint: "ASSET_LIBRARIAN.Settings.TagRegistry.Hint",
    scope: "world",
    config: false,
    type: Object,
    default: {}
  });

  game.settings.register("asset-librarian", "tagGroupConfig", {
    name: "ASSET_LIBRARIAN.Settings.TagGroupConfig.Name",
    hint: "ASSET_LIBRARIAN.Settings.TagGroupConfig.Hint",
    scope: "world",
    config: false,
    type: Object,
    default: {}
  });


  game.settings.register("asset-librarian", "openTags", {
    name: "ASSET_LIBRARIAN.Settings.openTags.Name",
    hint: "ASSET_LIBRARIAN.Settings.openTags.Hint",
    scope: "client",
    config: true,
    requiresReload: false,
    type: new foundry.data.fields.NumberField({nullable: false, min: 0, max: 10, step: 1}),
    default: 4
});

  // Settings menus
  game.settings.registerMenu("asset-librarian", "selectCompendiumsMenu", {
    name: "ASSET_LIBRARIAN.Menus.Compendiums.Name",
    label: "ASSET_LIBRARIAN.Menus.Compendiums.Label",
    hint: "ASSET_LIBRARIAN.Menus.Compendiums.Hint",
    icon: "fas fa-boxes-stacked",
    type: CompendiumSelectorApp,
    restricted: true
  });

  game.settings.registerMenu("asset-librarian", "customFilterFieldsMenu", {
    name: "ASSET_LIBRARIAN.Menus.Filters.Name",
    label: "ASSET_LIBRARIAN.Menus.Filters.Label",
    hint: "ASSET_LIBRARIAN.Menus.Filters.Hint",
    icon: "fas fa-filter",
    type: CustomFilterFieldsApp,
    restricted: true
  });

  game.settings.registerMenu("asset-librarian", "categoryConfigMenu", {
    name: "ASSET_LIBRARIAN.Menus.Categories.Name",
    label: "ASSET_LIBRARIAN.Menus.Categories.Label",
    hint: "ASSET_LIBRARIAN.Menus.Categories.Hint",
    icon: "fas fa-tags",
    type: CategoryConfigApp,
    restricted: true
  });

  game.settings.registerMenu("asset-librarian", "tagGroupConfigMenu", {
    name: "ASSET_LIBRARIAN.Menus.TagGroups.Name",
    label: "ASSET_LIBRARIAN.Menus.TagGroups.Label",
    hint: "ASSET_LIBRARIAN.Menus.TagGroups.Hint",
    icon: "fas fa-tags",
    type: TagGroupConfigApp,
    restricted: true
  });
};
