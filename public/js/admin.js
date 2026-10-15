const form = document.getElementById("upload-form");
const statusEl = document.getElementById("upload-status");
const submitBtn = document.getElementById("submit-btn");
const gamesListEl = document.getElementById("games-list");
const gamesEmptyEl = document.getElementById("games-empty");
const sourceSelectEl = document.getElementById("source-select");

const collectionForm = document.getElementById("collection-form");
const collectionStatusEl = document.getElementById("collection-status");
const collectionSubmitBtn = document.getElementById("collection-submit-btn");
const collectionsListEl = document.getElementById("collections-list");
const backupRestoreForm = document.getElementById("backup-restore-form");
const backupRestoreStatus = document.getElementById("backup-restore-status");
const backupRestoreButton = document.getElementById("backup-restore-btn");

let allCollections = [];
let allGames = [];

// Wraps fetch() for /api/admin/* calls: redirects to the login page if the
// session has expired or was never established, instead of failing silently.
async function af(url, opts) {
  const res = await fetch(url, opts);
  if (res.status === 401) {
    window.location.href = "login";
    throw new Error("unauthenticated");
  }
  return res;
}

async function loadSourceOptions() {
  const response = await af("/api/admin/sources");
  if (!response.ok) return;
  const sources = await response.json();
  const requestedId = new URLSearchParams(window.location.search).get("source") || "";
  const emptyOption = sourceSelectEl.options[0];
  sourceSelectEl.replaceChildren(emptyOption);
  for (const source of sources) {
    const option = document.createElement("option");
    option.value = source.id;
    option.textContent = `${source.name}${source.active ? "" : ` · ${t("sources_inactive")}`}`;
    sourceSelectEl.appendChild(option);
  }
  if (requestedId && sources.some((source) => source.id === requestedId)) {
    sourceSelectEl.value = requestedId;
  }
}

document.getElementById("logout-btn").addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST" });
  window.location.href = "login";
});

function formatSize(bytes) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// ---- Games ----

async function loadGames() {
  const res = await af("/api/admin/games");
  if (!res.ok) return;
  allGames = await res.json();
  renderGames();
}

function renderGames() {
  gamesListEl.innerHTML = "";
  gamesEmptyEl.classList.toggle("hidden", allGames.length > 0);

  for (const game of allGames) {
    const card = document.createElement("div");
    card.className = "game-row";

    card.appendChild(buildCoverUploader(game));

    const main = document.createElement("div");
    main.className = "game-row-main";
    main.appendChild(buildInfoEditor(game));

    const meta = document.createElement("div");
    meta.className = "game-row-meta";
    const hashShort = game.sha256 ? ` · SHA-256 ${game.sha256.slice(0, 12)}` : "";
    const sourceLabel = game.source ? ` · ${t("game_source_label")}: ${game.source.name}` : "";
    meta.textContent = `${game.file} · ${formatSize(game.sizeBytes || 0)}${hashShort}${sourceLabel}`;
    main.appendChild(meta);

    main.appendChild(buildTagsEditor(game));
    main.appendChild(buildCollectionChips(game));
    main.appendChild(buildAssetsEditor(game));
    main.appendChild(buildDiagnosticsControl(game));
    card.appendChild(main);

    const deleteBtn = document.createElement("button");
    deleteBtn.innerHTML = iconSvg("trash") + " " + t("remove_btn");
    deleteBtn.className = "delete-btn game-row-delete";
    deleteBtn.addEventListener("click", () => deleteGame(game.slug, game.title));
    card.appendChild(deleteBtn);

    gamesListEl.appendChild(card);
  }
}

// Shared by game and collection cover uploaders: a thumbnail (image or a
// color+initial placeholder) with a hidden file input on top, plus a
// hover-revealed camera icon so it's obvious the thumbnail is clickable —
// without it, it just looks like a plain, inert swatch of color.
function buildCoverUploaderBase({ imageUrl, alt, initial, title }) {
  const wrap = document.createElement("div");
  wrap.className = "cover-uploader";

  const thumb = document.createElement(imageUrl ? "img" : "div");
  thumb.className = "cover-thumb";
  if (imageUrl) {
    thumb.src = imageUrl;
    thumb.alt = alt;
  } else {
    thumb.textContent = initial;
  }

  const hint = document.createElement("div");
  hint.className = "cover-uploader-hint";
  hint.innerHTML = iconSvg("camera");

  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".jpg,.jpeg,.png,.webp";
  input.className = "cover-input";
  input.title = title;

  wrap.append(thumb, hint, input);
  return { wrap, input };
}

function buildCoverUploader(game) {
  const wrap = document.createElement("section");
  wrap.className = "game-cover-editor";

  const preview = document.createElement("div");
  preview.className = "game-cover-preview";
  if (game.cover) {
    const image = document.createElement("img");
    image.src = `covers/${encodeURIComponent(game.slug)}.${encodeURIComponent(game.cover)}?v=${game.coverVersion || 0}`;
    image.alt = game.title;
    if (game.coverSource === "flashpoint-logo") image.classList.add("logo-cover-image");
    image.onerror = () => {
      preview.replaceChildren();
      preview.classList.add("is-empty");
      preview.textContent = game.title.slice(0, 1).toUpperCase();
    };
    preview.appendChild(image);
  } else {
    preview.classList.add("is-empty");
    preview.textContent = game.title.slice(0, 1).toUpperCase();
  }

  const actions = document.createElement("div");
  actions.className = "game-cover-actions";
  const upload = document.createElement("button");
  upload.type = "button";
  upload.className = "game-cover-action";
  upload.innerHTML = iconSvg("image") + " " + t("cover_upload");

  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".jpg,.jpeg,.png,.webp";
  input.className = "hidden";
  input.setAttribute("aria-label", t("cover_upload"));
  upload.addEventListener("click", () => input.click());

  const status = document.createElement("span");
  status.className = "upload-status game-cover-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");

  const source = document.createElement("span");
  source.className = "game-cover-source-label";
  const sourceKey = (game.coverSource || "unknown").replace(/-/g, "_");
  source.textContent = t(`cover_source_${sourceKey}`);

  input.addEventListener("change", async () => {
    if (!input.files[0]) return;
    const formData = new FormData();
    formData.append("source", "upload");
    formData.append("cover", input.files[0]);
    actions.querySelectorAll("button").forEach((item) => (item.disabled = true));
    status.textContent = t("cover_updating");
    status.className = "upload-status game-cover-status";
    try {
      const res = await af(`/api/admin/games/${encodeURIComponent(game.slug)}/cover`, {
        method: "POST",
        body: formData,
      });
      if (res.ok) {
        await loadGames();
      } else {
        const data = await res.json().catch(() => ({}));
        status.textContent = data.error ? tError(data.error) : t("error_uploading_cover");
        status.classList.add("error");
      }
    } catch (error) {
      status.textContent = t("error_uploading_cover");
      status.classList.add("error");
    } finally {
      actions.querySelectorAll("button").forEach((item) => (item.disabled = false));
      input.value = "";
    }
  });

  actions.append(upload, input);

  if (game.flashpointId) {
    for (const kind of ["screenshot", "logo"]) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "game-cover-action game-cover-source";
      button.textContent = kind === "screenshot" ? t("cover_use_screenshot") : t("cover_use_logo");
      button.addEventListener("click", async () => {
        actions.querySelectorAll("button").forEach((item) => (item.disabled = true));
        status.textContent = t("cover_updating");
        status.className = "upload-status game-cover-status";
        try {
          const res = await af(`/api/admin/games/${encodeURIComponent(game.slug)}/flashpoint-cover`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ kind }),
          });
          if (res.ok) {
            await loadGames();
          } else {
            const data = await res.json().catch(() => ({}));
            status.textContent = data.error ? tError(data.error) : t("error_uploading_cover");
            status.classList.add("error");
          }
        } catch (error) {
          status.textContent = t("error_uploading_cover");
          status.classList.add("error");
        } finally {
          actions.querySelectorAll("button").forEach((item) => (item.disabled = false));
        }
      });
      actions.appendChild(button);
    }
  }

  wrap.append(preview, source, actions, status);
  return wrap;
}

function buildInfoEditor(game) {
  const wrap = document.createElement("div");
  wrap.className = "info-editor";

  const titleInput = document.createElement("input");
  titleInput.type = "text";
  titleInput.className = "title-input";
  titleInput.value = game.title;
  titleInput.maxLength = 100;
  titleInput.setAttribute("aria-label", t("label_title"));

  const titleLabel = document.createElement("label");
  titleLabel.className = "info-editor-label";
  titleLabel.textContent = t("label_title");
  const descLabel = document.createElement("label");
  descLabel.className = "info-editor-label";
  descLabel.textContent = t("label_description_optional");

  const descInput = document.createElement("textarea");
  descInput.className = "description-input";
  descInput.placeholder = t("description_placeholder");
  descInput.rows = 4;
  descInput.maxLength = 500;
  descInput.value = game.description || "";
  descInput.setAttribute("aria-label", t("label_description_optional"));
  const descCount = document.createElement("span");
  descCount.className = "description-count";
  const updateDescriptionCount = () => {
    descCount.textContent = t("description_count", { count: descInput.value.length, max: descInput.maxLength });
  };
  descInput.addEventListener("input", updateDescriptionCount);
  updateDescriptionCount();
  const saveStatus = document.createElement("span");
  saveStatus.className = "upload-status metadata-status";
  saveStatus.setAttribute("role", "status");
  saveStatus.setAttribute("aria-live", "polite");

  async function save(body, revert) {
    saveStatus.textContent = t("metadata_saving");
    saveStatus.className = "upload-status metadata-status";
    try {
      const res = await af(`/api/admin/games/${encodeURIComponent(game.slug)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (res.ok) {
        const updated = await res.json();
        Object.assign(game, updated);
        saveStatus.textContent = t("metadata_saved");
        saveStatus.classList.add("success");
        setTimeout(() => {
          if (saveStatus.textContent === t("metadata_saved")) saveStatus.textContent = "";
        }, 1800);
      } else {
        const data = await res.json().catch(() => ({}));
        saveStatus.textContent = data.error ? tError(data.error) : t("error_saving_game_info");
        saveStatus.classList.add("error");
        revert();
      }
    } catch (error) {
      saveStatus.textContent = t("error_saving_game_info");
      saveStatus.classList.add("error");
      revert();
    }
  }

  titleInput.addEventListener("change", () => {
    const value = titleInput.value.trim();
    if (!value) {
      titleInput.value = game.title;
      return;
    }
    save({ title: value }, () => (titleInput.value = game.title));
  });

  descInput.addEventListener("change", () => {
    save({ description: descInput.value }, () => (descInput.value = game.description || ""));
  });

  const rendererLabel = document.createElement("label");
  rendererLabel.className = "renderer-toggle";
  rendererLabel.title = t("renderer_toggle_hint");

  const rendererCheckbox = document.createElement("input");
  rendererCheckbox.type = "checkbox";
  rendererCheckbox.checked = game.renderer !== "canvas";

  rendererLabel.append(rendererCheckbox, document.createTextNode(" " + t("renderer_toggle_label")));

  rendererCheckbox.addEventListener("change", () => {
    const newRenderer = rendererCheckbox.checked ? "auto" : "canvas";
    save({ renderer: newRenderer }, () => (rendererCheckbox.checked = game.renderer !== "canvas"));
  });

  titleLabel.appendChild(titleInput);
  descLabel.append(descInput, descCount);
  wrap.append(titleLabel, descLabel, saveStatus, rendererLabel);
  return wrap;
}

function buildTagsEditor(game) {
  const input = document.createElement("input");
  input.type = "text";
  input.className = "tags-input";
  input.value = (game.tags || []).join(", ");
  input.placeholder = "tag1, tag2";

  input.addEventListener("change", async () => {
    const tags = input.value
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);

    const res = await af(`/api/admin/games/${encodeURIComponent(game.slug)}/tags`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tags }),
    });

    if (res.ok) {
      const updated = await res.json();
      input.value = (updated.tags || []).join(", ");
    } else {
      alert(t("error_saving_tags"));
    }
  });

  return input;
}

function buildCollectionChips(game) {
  const wrap = document.createElement("div");
  wrap.className = "collection-chips";

  if (allCollections.length === 0) {
    const hint = document.createElement("span");
    hint.className = "collection-hint";
    hint.textContent = t("create_collection_hint");
    wrap.appendChild(hint);
    return wrap;
  }

  for (const collection of allCollections) {
    const inCollection = collection.games.includes(game.slug);

    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "collection-chip" + (inCollection ? " active" : "");
    chip.textContent = collection.name;
    chip.title = inCollection
      ? t("remove_from_collection_title", { name: collection.name })
      : t("add_to_collection_title", { name: collection.name });

    chip.addEventListener("click", async () => {
      const method = inCollection ? "DELETE" : "POST";
      const url = inCollection
        ? `/api/admin/collections/${encodeURIComponent(collection.slug)}/games/${encodeURIComponent(game.slug)}`
        : `/api/admin/collections/${encodeURIComponent(collection.slug)}/games`;

      const res = await af(url, {
        method,
        headers: inCollection ? undefined : { "Content-Type": "application/json" },
        body: inCollection ? undefined : JSON.stringify({ gameSlug: game.slug }),
      });

      if (res.ok) {
        await loadCollections();
        loadGames();
      } else {
        alert(t("error_updating_collection"));
      }
    });

    wrap.appendChild(chip);
  }

  return wrap;
}

// Some Flash games load a sidecar file (an XML config, a level list...) at
// runtime, next to their .swf — not embedded in the movie, a separate
// request. The importer/uploader only ever handles the single .swf, so
// this is where an admin can attach whatever else that specific game
// needs by hand. See server/index.js's /game-assets static route and
// play.js's `base` load option for how these actually get served to it.
function buildAssetsEditor(game) {
  const wrap = document.createElement("div");
  wrap.className = "assets-editor";

  const header = document.createElement("div");
  header.className = "assets-editor-header";

  const label = document.createElement("span");
  label.className = "assets-editor-label";
  label.textContent = t("label_extra_files");
  label.title = t("extra_files_hint");

  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.className = "assets-input";

  header.append(label, input);
  wrap.appendChild(header);

  const list = document.createElement("ul");
  list.className = "assets-list";
  wrap.appendChild(list);

  async function refresh() {
    const res = await af(`/api/admin/games/${encodeURIComponent(game.slug)}/assets`);
    const files = res.ok ? await res.json() : [];
    list.innerHTML = "";

    if (files.length === 0) {
      const empty = document.createElement("li");
      empty.className = "assets-empty";
      empty.textContent = t("no_extra_files");
      list.appendChild(empty);
      return;
    }

    for (const filename of files) {
      const li = document.createElement("li");
      li.className = "assets-list-item";

      const name = document.createElement("span");
      name.textContent = filename;

      const deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.className = "asset-delete-btn";
      deleteBtn.innerHTML = iconSvg("trash");
      deleteBtn.title = t("remove_btn");
      deleteBtn.addEventListener("click", async () => {
        await af(`/api/admin/games/${encodeURIComponent(game.slug)}/assets/${encodeURIComponent(filename)}`, {
          method: "DELETE",
        });
        refresh();
      });

      li.append(name, deleteBtn);
      list.appendChild(li);
    }
  }

  input.addEventListener("change", async () => {
    if (!input.files.length) return;
    const formData = new FormData();
    for (const file of input.files) formData.append("files", file);

    const res = await af(`/api/admin/games/${encodeURIComponent(game.slug)}/assets`, {
      method: "POST",
      body: formData,
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      alert(data.error ? tError(data.error) : t("error_uploading_assets"));
    }
    input.value = "";
    refresh();
  });

  refresh();
  return wrap;
}

async function deleteGame(slug, title) {
  if (!confirm(t("confirm_remove_game", { title }))) return;

  const res = await af(`/api/admin/games/${encodeURIComponent(slug)}`, { method: "DELETE" });
  if (res.ok) {
    loadGames();
  } else {
    alert(t("error_removing_game"));
  }
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  statusEl.textContent = "";
  statusEl.className = "upload-status";

  const formData = new FormData(form);

  submitBtn.disabled = true;
  submitBtn.textContent = t("sending");

  try {
    const res = await af("/api/admin/games", {
      method: "POST",
      body: formData,
    });

    const data = await res.json();

    if (!res.ok) {
      statusEl.textContent = data.error ? tError(data.error) : t("error_submitting_game");
      statusEl.classList.add("error");
      addExistingGameLink(statusEl, data.existingGame);
    } else {
      statusEl.textContent = t("game_added_success", { title: data.title });
      if (data.sidecarHints && data.sidecarHints.length) {
        statusEl.append(` ${t("sidecar_hints_notice", { files: data.sidecarHints.join(", ") })}`);
      }
      statusEl.classList.add("success");
      form.reset();
      loadGames();
    }
  } catch (err) {
    statusEl.textContent = t("network_error_submitting_game");
    statusEl.classList.add("error");
  } finally {
    submitBtn.disabled = false;
    submitBtn.innerHTML = iconSvg("save") + " " + t("submit_game");
  }
});

// ---- Collections ----

async function loadCollections() {
  const res = await af("/api/admin/collections");
  if (!res.ok) return;
  allCollections = await res.json();
  renderCollectionsList();
}

function renderCollectionsList() {
  collectionsListEl.innerHTML = "";

  if (allCollections.length === 0) {
    const li = document.createElement("li");
    li.className = "collection-hint";
    li.textContent = t("no_collections_yet");
    collectionsListEl.appendChild(li);
    return;
  }

  for (const collection of allCollections) {
    const li = document.createElement("li");
    li.className = "collection-item";

    li.appendChild(buildCollectionCoverUploader(collection));

    const info = document.createElement("span");
    info.textContent = `${collection.name} (${tCount("games_count", collection.games.length)})`;

    const editBtn = document.createElement("button");
    editBtn.innerHTML = iconSvg("pencil") + " " + t("edit_btn");
    editBtn.className = "collection-edit-btn";
    editBtn.addEventListener("click", () => editCollection(collection));

    const deleteBtn = document.createElement("button");
    deleteBtn.innerHTML = iconSvg("trash") + " " + t("delete_btn");
    deleteBtn.className = "delete-btn";
    deleteBtn.addEventListener("click", () => deleteCollection(collection));

    li.append(info, editBtn, deleteBtn);
    collectionsListEl.appendChild(li);
  }
}

function buildCollectionCoverUploader(collection) {
  const { wrap, input } = buildCoverUploaderBase({
    imageUrl: collection.cover ? `covers/collections/${collection.slug}.${collection.cover}?t=${Date.now()}` : null,
    alt: collection.name,
    initial: collection.name.slice(0, 1).toUpperCase(),
    title: t("change_collection_cover_title"),
  });

  input.addEventListener("change", async () => {
    if (!input.files[0]) return;
    const formData = new FormData();
    formData.append("cover", input.files[0]);

    const res = await af(`/api/admin/collections/${encodeURIComponent(collection.slug)}/cover`, {
      method: "POST",
      body: formData,
    });

    if (res.ok) {
      loadCollections();
    } else {
      const data = await res.json().catch(() => ({}));
      alert(data.error ? tError(data.error) : t("error_uploading_cover"));
    }
  });

  return wrap;
}

async function editCollection(collection) {
  const newName = prompt(t("prompt_collection_name"), collection.name);
  if (newName === null) return;
  const newDescription = prompt(t("prompt_collection_description"), collection.description || "");
  if (newDescription === null) return;

  const res = await af(`/api/admin/collections/${encodeURIComponent(collection.slug)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: newName, description: newDescription }),
  });

  if (res.ok) {
    loadCollections();
  } else {
    alert(t("error_editing_collection"));
  }
}

async function deleteCollection(collection) {
  if (!confirm(t("confirm_delete_collection", { name: collection.name }))) return;

  const res = await af(`/api/admin/collections/${encodeURIComponent(collection.slug)}`, {
    method: "DELETE",
  });

  if (res.ok) {
    await loadCollections();
    loadGames();
  } else {
    alert(t("error_deleting_collection"));
  }
}

collectionForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  collectionStatusEl.textContent = "";
  collectionStatusEl.className = "upload-status";

  const formData = new FormData(collectionForm);
  collectionSubmitBtn.disabled = true;

  try {
    const res = await af("/api/admin/collections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: formData.get("name"),
        description: formData.get("description"),
      }),
    });

    const data = await res.json();

    if (!res.ok) {
      collectionStatusEl.textContent = data.error ? tError(data.error) : t("error_creating_collection");
      collectionStatusEl.classList.add("error");
    } else {
      collectionStatusEl.textContent = t("collection_created", { name: data.name });
      collectionStatusEl.classList.add("success");
      collectionForm.reset();
      await loadCollections();
      loadGames();
    }
  } catch (err) {
    collectionStatusEl.textContent = t("network_error_creating_collection");
    collectionStatusEl.classList.add("error");
  } finally {
    collectionSubmitBtn.disabled = false;
  }
});

function updateStaticText() {
  document.getElementById("back-link").innerHTML = iconSvg("arrow-left") + " " + t("nav_all_games");
  submitBtn.innerHTML = iconSvg("save") + " " + t("submit_game");
  collectionSubmitBtn.innerHTML = iconSvg("plus") + " " + t("submit_collection");
  flashpointSearchBtn.innerHTML = iconSvg("search") + " " + t("flashpoint_search_btn");
  backupRestoreButton.textContent = t("backup_restore");
}

// ---- Import from Flashpoint Archive ----

const flashpointForm = document.getElementById("flashpoint-search-form");
const flashpointQueryInput = document.getElementById("flashpoint-query");
const flashpointSearchBtn = document.getElementById("flashpoint-search-btn");
const flashpointStatusEl = document.getElementById("flashpoint-status");
const flashpointResultsEl = document.getElementById("flashpoint-results");
let flashpointImportInFlight = false;

function renderFlashpointResults(results) {
  flashpointResultsEl.innerHTML = "";
  for (const result of results) {
    const li = document.createElement("li");
    li.className = "flashpoint-result";

    const img = document.createElement("img");
    img.src = result.logo;
    img.alt = result.title;
    img.loading = "lazy";
    img.onerror = () => (img.style.visibility = "hidden");

    const title = document.createElement("span");
    title.className = "flashpoint-result-title";
    title.textContent = result.title;
    if (result.type) {
      const typeTag = document.createElement("span");
      typeTag.className = "flashpoint-result-type";
      typeTag.textContent = result.type;
      title.appendChild(typeTag);
    }

    const importBtn = document.createElement("button");
    importBtn.type = "button";
    importBtn.innerHTML = iconSvg("plus") + " " + t("flashpoint_import_btn");
    importBtn.addEventListener("click", () => importFromFlashpoint(result.id, importBtn));

    li.append(img, title, importBtn);
    flashpointResultsEl.appendChild(li);
  }
}

flashpointForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const query = flashpointQueryInput.value.trim();
  if (!query) return;

  flashpointStatusEl.textContent = "";
  flashpointStatusEl.className = "upload-status";
  flashpointResultsEl.innerHTML = "";
  flashpointSearchBtn.disabled = true;

  try {
    const res = await af(`/api/admin/flashpoint/search?q=${encodeURIComponent(query)}`);
    const data = await res.json();

    if (!res.ok) {
      flashpointStatusEl.textContent = data.error ? tError(data.error) : t("error_searching_flashpoint");
      flashpointStatusEl.classList.add("error");
    } else if (data.length === 0) {
      flashpointStatusEl.textContent = t("flashpoint_no_results");
    } else {
      renderFlashpointResults(data);
    }
  } catch (err) {
    flashpointStatusEl.textContent = t("network_error_searching_flashpoint");
    flashpointStatusEl.classList.add("error");
  } finally {
    flashpointSearchBtn.disabled = false;
  }
});

async function importFromFlashpoint(id, button) {
  if (flashpointImportInFlight) return;
  flashpointImportInFlight = true;
  flashpointStatusEl.textContent = "";
  flashpointStatusEl.className = "upload-status";
  flashpointResultsEl.querySelectorAll("button").forEach((item) => (item.disabled = true));
  flashpointSearchBtn.disabled = true;
  button.disabled = true;
  button.innerHTML = iconSvg("save") + " " + t("flashpoint_importing");

  try {
    const res = await af("/api/admin/flashpoint/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    const data = await res.json();

    if (res.ok) {
      button.innerHTML =
        iconSvg("save") +
        " " +
        (data.sidecarAssets && data.sidecarAssets.length > 0
          ? t("flashpoint_imported_with_assets", { count: data.sidecarAssets.length })
          : t("flashpoint_imported"));
      button.dataset.imported = "true";
      const installedSidecars = new Set((data.sidecarAssets || []).map((name) => name.toLowerCase()));
      const missingHints = (data.sidecarHints || []).filter((name) => !installedSidecars.has(name.toLowerCase()));
      if (missingHints.length) {
        flashpointStatusEl.textContent = t("sidecar_hints_notice", { files: missingHints.join(", ") });
        flashpointStatusEl.className = "upload-status";
      }
      loadGames();
    } else {
      button.innerHTML = iconSvg("plus") + " " + t("flashpoint_import_btn");
      flashpointStatusEl.textContent = data.error ? tError(data.error) : t("error_importing_flashpoint");
      flashpointStatusEl.classList.add("error");
      addExistingGameLink(flashpointStatusEl, data.existingGame);
    }
  } catch (err) {
    button.innerHTML = iconSvg("plus") + " " + t("flashpoint_import_btn");
    flashpointStatusEl.textContent = t("network_error_importing_flashpoint");
    flashpointStatusEl.classList.add("error");
  } finally {
    flashpointImportInFlight = false;
    flashpointSearchBtn.disabled = false;
    flashpointResultsEl.querySelectorAll("button").forEach((item) => {
      item.disabled = item.dataset.imported === "true";
    });
  }
}

backupRestoreForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!backupRestoreForm.elements.backup.files[0]) return;
  if (!window.confirm(t("backup_restore_confirm"))) return;
  backupRestoreStatus.textContent = "";
  backupRestoreStatus.className = "upload-status";
  backupRestoreButton.disabled = true;
  backupRestoreButton.textContent = t("backup_restoring");
  try {
    const response = await af("/api/admin/backup/restore", {
      method: "POST",
      body: new FormData(backupRestoreForm),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      backupRestoreStatus.textContent = data.error ? tError(data.error) : t("backup_restore_failed");
      backupRestoreStatus.classList.add("error");
      return;
    }
    backupRestoreStatus.textContent = t("backup_restore_success", { games: data.games, files: data.files });
    backupRestoreStatus.classList.add("success");
    backupRestoreForm.reset();
    await loadSourceOptions();
    await loadCollections();
    await loadGames();
  } catch (error) {
    if (error.message === "unauthenticated") return;
    backupRestoreStatus.textContent = t("network_error_restoring_backup");
    backupRestoreStatus.classList.add("error");
  } finally {
    backupRestoreButton.disabled = false;
    backupRestoreButton.textContent = t("backup_restore");
  }
});

function buildDiagnosticsControl(game) {
  const section = document.createElement("section");
  section.className = "game-diagnostics-control";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "game-cover-action";
  button.textContent = t("analyze_game");
  const output = document.createElement("div");
  output.className = "game-diagnostics hidden";
  output.setAttribute("role", "status");
  output.setAttribute("aria-live", "polite");
  button.addEventListener("click", async () => {
    if (!output.classList.contains("hidden")) {
      output.classList.add("hidden");
      button.textContent = t("analyze_game");
      return;
    }
    button.disabled = true;
    button.textContent = t("analyzing_game");
    output.textContent = "";
    try {
      const response = await af(`/api/admin/games/${encodeURIComponent(game.slug)}/diagnostics`);
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "game_diagnostics_unavailable");
      const analysis = data.analysis;
      const missing = analysis.missingSidecarHints.length
        ? analysis.missingSidecarHints.join(", ")
        : t("diagnostic_no_missing_sidecars");
      const sizeNote = analysis.declaredSizeMatches === false
        ? ` · ${t("diagnostic_declared_size_mismatch")}`
        : analysis.declaredSizeMatches === null
          ? ` · ${t("diagnostic_size_unverified")}`
          : "";
      output.textContent = [
        `${t("diagnostic_swf")}: ${analysis.valid ? t("diagnostic_valid") : t("diagnostic_invalid")}`,
        `${t("diagnostic_format")}: ${analysis.format} · v${analysis.version ?? "?"} · ${analysis.compression}`,
        `${t("diagnostic_size")}: ${formatSize(analysis.actualBytes)} · ${t("diagnostic_header_size")}: ${formatSize(analysis.declaredBytes || 0)}${sizeNote}`,
        `SHA-256: ${analysis.sha256}`,
        `${t("diagnostic_ruffle")}: ${data.ruffle.ready ? (data.ruffle.version || t("diagnostic_available")) : t("diagnostic_missing")}`,
        `${t("diagnostic_sidecars")}: ${missing}`,
        analysis.compression === "lzma"
          ? `${t("diagnostic_limits_note")} ${t("diagnostic_lzma_note")}`
          : t("diagnostic_limits_note"),
      ].join("\n");
      output.classList.remove("hidden");
      button.textContent = t("hide_diagnostics");
    } catch (error) {
      if (error.message === "unauthenticated") return;
      output.textContent = tError(error.message);
      output.classList.remove("hidden");
    } finally {
      button.disabled = false;
      if (button.textContent === t("analyzing_game")) button.textContent = t("analyze_game");
    }
  });
  section.append(button, output);
  return section;
}

function addExistingGameLink(target, game) {
  if (!game || !game.slug) return;
  const link = document.createElement("a");
  link.href = `play?slug=${encodeURIComponent(game.slug)}`;
  link.textContent = t("open_existing_game");
  target.append(" ", link);
}

initThemeToggle(document.getElementById("theme-select"));
initLangToggle(document.getElementById("lang-select"));
updateStaticText();

function onLanguageChange() {
  updateStaticText();
  renderGames();
  renderCollectionsList();
}

async function init() {
  await loadSourceOptions();
  await loadCollections();
  loadGames();
}

init();
