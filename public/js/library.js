const grid = document.getElementById("grid");
const emptyMsg = document.getElementById("empty");
const searchInput = document.getElementById("search");
const tagsRow = document.getElementById("tags-row");
const moreButton = document.getElementById("load-more");
const statusEl = document.getElementById("library-status");
const favoritesOnly = document.body.dataset.favoritesOnly === "true";
const PAGE_SIZE = 60;

let allGames = [];
let activeTag = "";
let currentPage = 1;
let hasMore = false;
let searchTimer = null;
let requestController = null;
let requestVersion = 0;
let lastTags = [];

function renderGames(games, { append = false } = {}) {
  if (!append) grid.replaceChildren();
  emptyMsg.classList.toggle("hidden", grid.childElementCount + games.length > 0);
  for (const game of games) grid.appendChild(buildGameCard(game));
}

function setStatus(message, error = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", error);
  statusEl.classList.toggle("hidden", !message);
}

function renderTags() {
  if (favoritesOnly || lastTags.length === 0) {
    tagsRow.classList.add("hidden");
    return;
  }
  tagsRow.classList.remove("hidden");
  tagsRow.replaceChildren();
  const allChip = document.createElement("button");
  allChip.className = "tag-chip" + (activeTag === "" ? " active" : "");
  allChip.innerHTML = iconSvg("tag");
  allChip.append(document.createTextNode(` ${t("tag_all")}`));
  allChip.dataset.tag = "";
  allChip.addEventListener("click", () => setActiveTag(""));
  tagsRow.appendChild(allChip);
  for (const { tag, count } of lastTags) {
    const chip = document.createElement("button");
    chip.className = "tag-chip" + (activeTag === tag ? " active" : "");
    chip.innerHTML = iconSvg("tag");
    chip.append(document.createTextNode(` ${tag} (${count})`));
    chip.dataset.tag = tag;
    chip.addEventListener("click", () => setActiveTag(tag));
    tagsRow.appendChild(chip);
  }
}

async function loadFavoriteGames() {
  const response = await fetch("/api/favorites");
  if (!response.ok) throw new Error("favorites_unavailable");
  const data = await response.json();
  return data.items || [];
}

async function loadGames({ append = false } = {}) {
  const version = ++requestVersion;
  if (requestController) requestController.abort();
  requestController = new AbortController();
  const q = searchInput.value.trim();
  setStatus(t("loading"));
  moreButton.classList.add("hidden");
  try {
    if (favoritesOnly) {
      if (!append) allGames = await loadFavoriteGames();
      if (version !== requestVersion) return;
      let filtered = allGames;
      const needle = q.toLocaleLowerCase();
      if (needle) filtered = filtered.filter((game) => [game.title, game.description, ...(game.tags || [])].filter(Boolean).some((value) => String(value).toLocaleLowerCase().includes(needle)));
      if (activeTag) filtered = filtered.filter((game) => (game.tags || []).includes(activeTag));
      renderGames(filtered);
      setStatus("");
      return;
    }

    const page = append ? currentPage + 1 : 1;
    const query = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
    if (q) query.set("q", q);
    if (activeTag) query.set("tag", activeTag);
    const response = await fetch(`/api/games?${query}`, { signal: requestController.signal });
    if (!response.ok) throw new Error("library_unavailable");
    const result = await response.json();
    if (version !== requestVersion) return;
    currentPage = page;
    hasMore = result.hasMore;
    renderGames(result.items, { append });
    moreButton.classList.toggle("hidden", !hasMore);
    setStatus(tCount("games_count", result.total));
  } catch (error) {
    if (error.name === "AbortError") return;
    if (!append) renderGames([]);
    setStatus(t("library_load_error"), true);
  }
}

async function loadTags() {
  if (favoritesOnly) return;
  try {
    const response = await fetch("/api/tags");
    if (response.ok) lastTags = await response.json();
  } catch (error) {
    lastTags = [];
  }
  renderTags();
}

function setActiveTag(tag) {
  activeTag = tag;
  renderTags();
  loadGames();
}

searchInput.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => loadGames(), 180);
});
moreButton.addEventListener("click", () => loadGames({ append: true }));
document.addEventListener("flashback:favorites-changed", (event) => {
  if (favoritesOnly && event.detail.favorite === false) loadGames();
});

initViewToggle(grid, document.getElementById("view-toggle"));
initThemeToggle(document.getElementById("theme-select"));
initLangToggle(document.getElementById("lang-select"));

function onLanguageChange() {
  renderTags();
  loadGames();
}

(async () => {
  await loadFavoriteSlugs();
  await Promise.all([loadGames(), loadTags()]);
})();
