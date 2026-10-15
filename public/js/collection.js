const params = new URLSearchParams(window.location.search);
const slug = params.get("slug");

const titleEl = document.getElementById("collection-title");
const descEl = document.getElementById("collection-description");
const grid = document.getElementById("grid");
const emptyMsg = document.getElementById("empty");

async function main() {
  if (!slug) {
    titleEl.textContent = t("collection_not_specified");
    return;
  }

  const res = await fetch(`/api/collections/${encodeURIComponent(slug)}`);
  if (!res.ok) {
    titleEl.textContent = t("collection_not_found");
    return;
  }

  const collection = await res.json();
  await loadFavoriteSlugs();
  titleEl.textContent = collection.name;
  document.title = `${collection.name} — FlashBack`;
  descEl.textContent = collection.description || "";

  emptyMsg.classList.toggle("hidden", collection.games.length > 0);
  for (const game of collection.games) {
    grid.appendChild(buildGameCard(game));
}
}

document.getElementById("back-link").innerHTML = iconSvg("arrow-left") + " " + t("nav_collections");
initViewToggle(grid, document.getElementById("view-toggle"));
initThemeToggle(document.getElementById("theme-select"));
initLangToggle(document.getElementById("lang-select"));

function onLanguageChange() {
  document.getElementById("back-link").innerHTML = iconSvg("arrow-left") + " " + t("nav_collections");
}

main();
