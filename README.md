# Asset Librarian

Foundry VTT module for browsing world and compendium assets across these document types:

- Actor
- Item
- JournalEntry
- Scene
- RollTable
- Playlist
- Macro
- Cards
- Images (optional)

## Open The App

- Keybinding: `Ctrl+L`
- Scene control button: `Asset Librarian`

## Macro And Console API

Public API is exposed on `game.assetLibrarian`.

### Open with mode and tab

```js
game.assetLibrarian.open(mode, tab)
```

Examples:

```js
game.assetLibrarian.open("world", "Item");
game.assetLibrarian.open("compendium", "Actor");
game.assetLibrarian.open("world", "rolltables");
```

### Open with filters

```js
game.assetLibrarian.open(mode, tab, options)
```

Options:

- `clearExistingFilters` (`boolean`, default `true`)
- `filters` (`Array`) explicit filter targets:
  - `{ key, value, state }`
  - `state`: `"include" | "and" | "exclude"`
- `tagFilters` shorthand for `filterTag`:
  - string (comma-separated)
  - string array
  - object map (`{ tag: state }`)
  - object array (`{ value, state }`)
- `tagFilterState` default state for `tagFilters` when state is omitted (`"include"` by default)

Examples:

```js
// Unambiguous filter targeting by key + value
game.assetLibrarian.open("world", "Item", {
  clearExistingFilters: true,
  filters: [
    { key: "color", value: "black", state: "include" },
    { key: "mode", value: "black", state: "and" }
  ]
});

// Shorthand for custom filterTag group
game.assetLibrarian.open("compendium", "Actor", {
  tagFilters: ["boss", "elite"],
  tagFilterState: "include"
});
```

### Alias

```js
game.assetLibrarian.render(mode, tab, options)
```

`render` is an alias of `open`.

### Accepted mode values

- `"world"`
- `"compendium"`

### Accepted tab values

Canonical:

- `Actor`
- `Item`
- `JournalEntry`
- `Scene`
- `RollTable`
- `Playlist`
- `Macro`
- `Cards`
- `Image`

Also accepts common lowercase/plural aliases:

- `actors`, `items`, `journals`, `scenes`, `rolltables`, `playlists`, `macros`, `cards`, `images`

## Window Title Behavior

The app title updates by mode:

- `Asset Librarian - World View`
- `Asset Librarian - Compendium View`

## Settings

Module settings include:

- Per-tab visibility toggles (`Show Actors`, `Show Items`, etc.)
- Enable image scanning
- Include world images
- Compendium selection menu
- Category configuration menu
- Custom filter fields menu

## Custom Tagging

For these tabs:

- `JournalEntry`
- `Scene`
- `Playlist`
- `Macro`
- `RollTable`
- `Cards`

you can assign custom tags from the card context menu using `Edit Tags`.

### Tag types

- `categoryTag` (single value)
  - Drives the category bar for those tabs.
- `filterTag` (multiple values)
  - Drives the `Tags` group in the filter panel.

### Tag editor behavior

- Existing known tags are shown as selectable chips.
- You can add new tags with the add input/buttons.
- Selecting an existing chip toggles assignment.

### Compendium behavior

- Tag flags are indexed for compendiums during `init`:
  - `flags.asset-librarian.categoryTag`
  - `flags.asset-librarian.filterTag`
- `Edit Tags` is hidden for locked compendiums.

### Tag groups

- GMs can create custom tag groups from the Asset Librarian header (`Configure Tag Groups`).
- Groups are configured per document type.
- A tag can be assigned to only one custom group per document type.
- In the filter sidebar, custom tag groups are shown first and the default `Tags` group (all tags) is shown below them.
- `Reset Defaults` in Tag Group Configuration removes custom groups only (it does not remove tags from documents).

## Context Menu Actions

### Item

- Send to player
- View art
- Configure ownership
- Import from compendium (compendium entries)

### Actor

- View character art
- View token art
- Configure ownership

### JournalEntry

- Jump to map pin (if note exists)
- Configure ownership

### Macro

- Execute
- Configure ownership

### Playlist

- Bulk import
- Configure ownership

### RollTable

- Draw result
- Configure ownership

### Cards

Actions are type-gated:

- `hand`: `drawDialog()`, `passDialog()`
- `deck`: `dealDialog()`, `shuffle()`
- `pile`: `passDialog()`, `shuffle()`

## Notes

- Compendium include/exclude changes invalidate compendium cache and update the open browser immediately.
- Category buttons hide when their group count is zero.

## Custom Filter Path Examples

Use these in custom filters:

- `system.details.habitat.value[type]`
  - Returns: `forest`, `grassland`, `hill`, `planar`, `underdark`

- `system.details.habitat.value[subtype]`
  - Returns subtype values where present (for example `acheron`)
