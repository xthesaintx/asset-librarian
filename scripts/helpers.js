export const ASSET_LIBRARIAN_BASE_TABS = ["Actor", "Item", "JournalEntry", "Scene", "RollTable", "Playlist", "Macro", "Cards", "Adventure"];

export class helpers {

static async confirmationDialog(message = game.i18n.localize("ASSET_LIBRARIAN.Helpers.ConfirmDefault")) {
        const proceed = await foundry.applications.api.DialogV2.confirm({
            content: message,
            rejectClose: false,
            modal: true,
            classes: ["asset-librarian", "dialog"]
        });
        return proceed;
    }

/**
* Create a Tile centered in the current view
*/
static async createTile(li) {
    const src = li.dataset.uuid;
    if (!canvas.ready) return ui.notifications.warn(game.i18n.localize("ASSET_LIBRARIAN.Helpers.CanvasNotReady"));
    
    const tex = await foundry.canvas.loadTexture(src);
    const w = tex.baseTexture.width;
    const h = tex.baseTexture.height;
    
    const screenCenter = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    const center = canvas.stage.toLocal(screenCenter);
    
    return canvas.scene.createEmbeddedDocuments("Tile", [{
        texture: { src },
        width: w,
        height: h,
        x: center.x - (w / 2),
        y: center.y - (h / 2)
    }]);
}

    /**
     * Changes the background of the current scene
     * @param {HTMLElement} li
     */
    static async changeBackground(li) {
        const src = li.dataset.uuid;
        const confirm = await this.confirmationDialog(
          game.i18n.format("ASSET_LIBRARIAN.Helpers.ConfirmChangeBackground", { sceneName: canvas.scene.name })
        );
        
        if (confirm) {
            return canvas.scene.update({ "background.src": src });
        }
    }

    /**
     * Creates a new Scene sized to the image
     * @param {HTMLElement} li
     */
    static async createScene(li) {
        const src = li.dataset.uuid;
        const tex = await foundry.canvas.loadTexture(src);
        const name = li.querySelector('.asset-name')?.textContent || game.i18n.localize("ASSET_LIBRARIAN.Helpers.NewScene");

        return Scene.create({
            name: name,
            background: { src },
            width: tex.baseTexture.width,
            height: tex.baseTexture.height,
            grid: { size: 100 },
            padding: 0 
        });
    }


static async createPlayerSelectionDialog(itemName, onPlayerSelected) {
    const allowedTypes = ["character", "player", "group"];

    const playerCharacters = game.actors
      .filter((actor) => actor.type && allowedTypes.includes(actor.type.toLowerCase()))
      .sort((a, b) => {
        const aAssigned = game.users.some(u => u.character?.uuid === a.uuid);
        const bAssigned = game.users.some(u => u.character?.uuid === b.uuid);

        if (aAssigned && !bAssigned) return -1;
        if (!aAssigned && bAssigned) return 1;
        return a.name.localeCompare(b.name);
      });

    if (playerCharacters.length === 0) {
      ui.notifications.warn(game.i18n.localize("ASSET_LIBRARIAN.Helpers.NoPlayerCharacters"));
      return;
    }

    const content = `
      <div class="player-selection header">
        <p>${game.i18n.format("ASSET_LIBRARIAN.Helpers.SendItemPrompt", { itemName })}</p>
        
        <div class="form-group" style="margin-bottom: 10px;">
            <input type="text" name="filter" placeholder="${game.i18n.localize("ASSET_LIBRARIAN.Helpers.FilterCharacters")}" autocomplete="off">
        </div>
      </div>
      <div class="player-selection playerlist">

        <div class="player-list">
          ${playerCharacters
            .map((char) => {
              const assignedUser = game.users.find((u) => u.character?.uuid === char.uuid);
              const userInfo = assignedUser
                ? ` (${assignedUser.name})`
                : ` (${game.i18n.localize("ASSET_LIBRARIAN.Helpers.Unassigned")})`;

              return `
              <div class="player-option" data-actor-uuid="${char.uuid}" >
                <img src="${char.img}" alt="${char.name}">
                <div class="player-info">
                  <span class="character-name" >${char.name}</span>
                  <span class="user-info" >${userInfo}</span>
                </div>
              </div>
            `;
            })
            .join("")}
        </div>
      </div>
    `;

    const dialog = new foundry.applications.api.DialogV2({
      window: {
        title: game.i18n.localize("ASSET_LIBRARIAN.Helpers.SendItemTitle"),
              	resizable:true

      },
      position:{
      	width:"auto",
      	height:400,
      },
      classes: ["asset-librarian", "send-to-player"],
      content: content,
      buttons: [
        {
          action: "cancel",
          icon: "fas fa-times",
          label: game.i18n.localize("ASSET_LIBRARIAN.Helpers.Cancel"),
        },
      ],
    });

    await dialog.render(true);

    const filterInput = dialog.element.querySelector("input[name='filter']");
    const playerOptions = dialog.element.querySelectorAll(".player-option");

    filterInput.focus();

    filterInput.addEventListener("input", (event) => {
      const query = event.target.value.toLowerCase().trim();
      
      playerOptions.forEach((option) => {
        const name = option.querySelector(".character-name").innerText.toLowerCase();
        const user = option.querySelector(".user-info").innerText.toLowerCase();
        const match = name.includes(query) || user.includes(query);
        option.style.display = match ? "flex" : "none";
      });
    });

    playerOptions.forEach((element) => {
      element.addEventListener("click", async (event) => {
        const actorUuid = event.currentTarget.dataset.actorUuid;
        const actor = await fromUuid(actorUuid);
        if (actor) {
          onPlayerSelected(actor);
        }
        dialog.close();
      });
    
    });
  }

  static async transferItemToActor(item, targetActor) {
    try {
      const itemData = item.toObject();
      delete itemData._id;
      const existingItem = targetActor.items.find(i => 
          i.getFlag("core", "_stats.compendiumSource") === item.uuid || 
            (i.name === item.name && i.type === item.type && i.img === item.img)
           );
          if (existingItem) {
            const currentQty = existingItem.system.quantity || 0;
            await existingItem.update({ "system.quantity": currentQty+1 });
          } else {
            itemData.system.quantity = 1;
            await targetActor.createEmbeddedDocuments("Item", [itemData]);
          }
      ui.notifications.info(game.i18n.localize("ASSET_LIBRARIAN.Helpers.ItemSent"));
      const targetUser = game.users.find((u) => u.character?.id === targetActor.id);
      if (targetUser && targetUser.active) {
        ChatMessage.create({
          content: game.i18n.format("ASSET_LIBRARIAN.Helpers.WhisperSentItem", {
            sender: game.user.name,
            item: item.name,
            source: document.name
          }),
          whisper: [targetUser.id],
        });
      }
    } catch (error) {
      console.error("Error transferring item:", error);
    }
  }

}
