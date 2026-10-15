const sourceForm = document.getElementById("source-form");
const sourceFormStatus = document.getElementById("source-form-status");
const sourceSaveButton = document.getElementById("source-save-btn");
const sourceFormHeading = document.getElementById("source-form-heading");
const sourceList = document.getElementById("sources-list");
const sourceSearch = document.getElementById("source-search");
const sourceFilter = document.getElementById("source-filter");
const sourceCount = document.getElementById("source-count");
const sourceEmpty = document.getElementById("sources-empty");
const sourceNoMatch = document.getElementById("sources-no-match");
const sourceLoadError = document.getElementById("sources-load-error");
const sourceCancelButton = document.getElementById("source-cancel-btn");

let sources = [];
let editingSourceId = null;

initLangToggle(document.getElementById("lang-select"));
initThemeToggle(document.getElementById("theme-select"));

document.getElementById("logout-btn").addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST" });
  window.location.href = "login";
});

function sourceApiError(code) {
  const translated = tError(code || "source_error_saving");
  return translated.startsWith("err_") ? t("source_error_saving") : translated;
}

async function sourceRequest(url, options = {}) {
  let response;
  try {
    response = await fetch(url, options);
  } catch (error) {
    throw new Error("network_error");
  }
  if (response.status === 401) {
    window.location.href = "login";
    throw new Error("unauthenticated");
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "source_error_saving");
  return payload;
}

function setFormStatus(message = "", isError = false) {
  sourceFormStatus.textContent = message;
  sourceFormStatus.classList.toggle("error", isError);
}

function resetSourceForm() {
  editingSourceId = null;
  sourceForm.reset();
  sourceFormHeading.textContent = t("sources_add_heading");
  sourceSaveButton.textContent = t("sources_save");
  sourceCancelButton.classList.add("hidden");
  setFormStatus();
}

function sourceTypeLabel(type) {
  const keys = {
    catalog: "sources_type_catalog",
    playable: "sources_type_playable",
    "direct-swf": "sources_type_direct_swf",
  };
  return t(keys[type] || "sources_type_catalog");
}

function buildSourceCard(source) {
  const card = document.createElement("article");
  card.className = `source-card${source.active ? "" : " is-inactive"}`;

  const content = document.createElement("div");
  content.className = "source-card-content";

  const titleRow = document.createElement("div");
  titleRow.className = "source-card-title-row";
  const title = document.createElement("h3");
  title.textContent = source.name;
  titleRow.appendChild(title);
  if (!source.active) {
    const inactive = document.createElement("span");
    inactive.className = "source-status-pill";
    inactive.textContent = t("sources_inactive");
    titleRow.appendChild(inactive);
  }
  const health = document.createElement("span");
  health.className = `source-health-pill source-health-${source.healthStatus || "unchecked"}`;
  health.textContent = t(`sources_health_${source.healthStatus || "unchecked"}`);
  if (source.healthCheckedAt) {
    const checkedAt = new Date(source.healthCheckedAt);
    const detail = [
      Number.isNaN(checkedAt.getTime()) ? "" : checkedAt.toLocaleString(),
      source.healthHttpStatus ? `HTTP ${source.healthHttpStatus}` : "",
    ].filter(Boolean).join(" · ");
    health.title = detail;
    health.setAttribute("aria-label", `${health.textContent}${detail ? ` · ${detail}` : ""}`);
  }
  titleRow.appendChild(health);
  content.appendChild(titleRow);

  const link = document.createElement("a");
  link.className = "source-url";
  link.href = source.url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = source.url;
  link.title = source.url;
  content.appendChild(link);

  const meta = document.createElement("div");
  meta.className = "source-card-meta";
  const type = document.createElement("span");
  type.className = "source-type-pill";
  type.textContent = sourceTypeLabel(source.type);
  meta.appendChild(type);
  for (const tagText of source.tags || []) {
    const tag = document.createElement("span");
    tag.className = "source-tag";
    tag.textContent = tagText;
    meta.appendChild(tag);
  }
  content.appendChild(meta);

  if (source.notes) {
    const notes = document.createElement("p");
    notes.className = "source-notes";
    notes.textContent = source.notes;
    content.appendChild(notes);
  }
  card.appendChild(content);

  const actions = document.createElement("div");
  actions.className = "source-card-actions";

  const openButton = document.createElement("a");
  openButton.className = "source-action-btn source-open-btn";
  openButton.href = source.url;
  openButton.target = "_blank";
  openButton.rel = "noopener noreferrer";
  openButton.textContent = t("sources_open");
  actions.appendChild(openButton);

  const importButton = document.createElement("a");
  importButton.className = "source-action-btn";
  importButton.href = `admin?source=${encodeURIComponent(source.id)}#upload-form`;
  importButton.textContent = t("sources_import_swf");
  actions.appendChild(importButton);

  const checkButton = document.createElement("button");
  checkButton.type = "button";
  checkButton.className = "source-action-btn";
  checkButton.textContent = t("sources_check_link");
  checkButton.addEventListener("click", async () => {
    checkButton.disabled = true;
    checkButton.textContent = t("sources_checking_link");
    try {
      const updated = await sourceRequest(`/api/admin/sources/${encodeURIComponent(source.id)}/check`, {
        method: "POST",
      });
      sources = sources.map((item) => item.id === updated.id ? updated : item);
      renderSources();
    } catch (error) {
      if (error.message !== "unauthenticated") {
        window.alert(error.message === "network_error" ? t("source_error_network") : sourceApiError(error.message));
      }
      checkButton.disabled = false;
      checkButton.textContent = t("sources_check_link");
    }
  });
  actions.appendChild(checkButton);

  const editButton = document.createElement("button");
  editButton.type = "button";
  editButton.className = "source-action-btn";
  editButton.textContent = t("sources_edit");
  editButton.addEventListener("click", () => editSource(source));
  actions.appendChild(editButton);

  const toggleButton = document.createElement("button");
  toggleButton.type = "button";
  toggleButton.className = "source-action-btn";
  toggleButton.textContent = t(source.active ? "sources_deactivate" : "sources_activate");
  toggleButton.addEventListener("click", () => updateSource(source, { active: !source.active }));
  actions.appendChild(toggleButton);

  const deleteButton = document.createElement("button");
  deleteButton.type = "button";
  deleteButton.className = "source-action-btn source-delete-btn";
  deleteButton.textContent = t("sources_delete");
  deleteButton.addEventListener("click", () => deleteSource(source));
  actions.appendChild(deleteButton);

  card.appendChild(actions);
  return card;
}

function renderSources() {
  const query = sourceSearch.value.trim().toLocaleLowerCase();
  const state = sourceFilter.value;
  const visibleSources = sources.filter((source) => {
    if (state === "active" && !source.active) return false;
    if (state === "inactive" && source.active) return false;
    if (!query) return true;
    const searchable = [source.name, source.url, source.notes, ...(source.tags || [])]
      .join(" ")
      .toLocaleLowerCase();
    return searchable.includes(query);
  });

  sourceList.replaceChildren(...visibleSources.map(buildSourceCard));
  sourceCount.textContent = t(visibleSources.length === 1 ? "sources_count_one" : "sources_count_other", {
    n: visibleSources.length,
  });
  sourceEmpty.classList.toggle("hidden", sources.length > 0);
  sourceNoMatch.classList.toggle("hidden", sources.length === 0 || visibleSources.length > 0);
}

async function loadSources() {
  sourceLoadError.classList.add("hidden");
  try {
    sources = await sourceRequest("/api/admin/sources");
    renderSources();
  } catch (error) {
    if (error.message === "unauthenticated") return;
    sourceLoadError.textContent = error.message === "network_error" || !error.message.startsWith("source_")
      ? t("source_error_loading")
      : sourceApiError(error.message);
    sourceLoadError.classList.remove("hidden");
  }
}

function editSource(source) {
  editingSourceId = source.id;
  sourceForm.elements.name.value = source.name;
  sourceForm.elements.url.value = source.url;
  sourceForm.elements.type.value = source.type;
  sourceForm.elements.tags.value = (source.tags || []).join(", ");
  sourceForm.elements.notes.value = source.notes || "";
  sourceFormHeading.textContent = t("sources_edit_heading");
  sourceSaveButton.textContent = t("sources_save");
  sourceCancelButton.classList.remove("hidden");
  setFormStatus();
  sourceForm.scrollIntoView({ behavior: "smooth", block: "center" });
  sourceForm.elements.name.focus({ preventScroll: true });
}

async function updateSource(source, updates) {
  try {
    const updated = await sourceRequest(`/api/admin/sources/${encodeURIComponent(source.id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...source, ...updates }),
    });
    sources = sources.map((item) => item.id === updated.id ? updated : item);
    renderSources();
  } catch (error) {
    if (error.message !== "unauthenticated") {
      window.alert(error.message === "network_error" ? t("source_error_network") : sourceApiError(error.message));
    }
  }
}

async function deleteSource(source) {
  if (!window.confirm(t("confirm_delete_source", { name: source.name }))) return;
  try {
    await sourceRequest(`/api/admin/sources/${encodeURIComponent(source.id)}`, { method: "DELETE" });
    sources = sources.filter((item) => item.id !== source.id);
    if (editingSourceId === source.id) resetSourceForm();
    renderSources();
  } catch (error) {
    if (error.message !== "unauthenticated") {
      window.alert(error.message === "network_error" ? t("source_error_network") : sourceApiError(error.message));
    }
  }
}

sourceForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setFormStatus();
  sourceSaveButton.disabled = true;

  const sourceData = {
    name: sourceForm.elements.name.value,
    url: sourceForm.elements.url.value,
    type: sourceForm.elements.type.value,
    tags: sourceForm.elements.tags.value,
    notes: sourceForm.elements.notes.value,
  };

  try {
    if (editingSourceId) {
      const updated = await sourceRequest(`/api/admin/sources/${encodeURIComponent(editingSourceId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sourceData),
      });
      sources = sources.map((source) => source.id === updated.id ? updated : source);
      resetSourceForm();
      setFormStatus(t("sources_updated"));
    } else {
      const created = await sourceRequest("/api/admin/sources", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sourceData),
      });
      sources = [...sources, created];
      resetSourceForm();
      setFormStatus(t("sources_saved"));
    }
    renderSources();
  } catch (error) {
    if (error.message === "unauthenticated") return;
    setFormStatus(error.message === "network_error"
      ? t("source_error_network")
      : sourceApiError(error.message), true);
  } finally {
    sourceSaveButton.disabled = false;
  }
});

sourceCancelButton.addEventListener("click", resetSourceForm);
sourceSearch.addEventListener("input", renderSources);
sourceFilter.addEventListener("change", renderSources);
window.addEventListener("flashback:language-changed", () => {
  if (editingSourceId) {
    sourceFormHeading.textContent = t("sources_edit_heading");
    sourceSaveButton.textContent = t("sources_save");
  }
  renderSources();
});

loadSources();
