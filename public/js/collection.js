const params = new URLSearchParams(window.location.search);
const slug = params.get("slug");

const titleEl = document.getElementById("collection-title");
const descEl = document.getElementById("collection-description");
const grid = document.getElementById("grid");
const emptyMsg = document.getElementById("empty");
const errorMsg = document.getElementById("load-error");

function showLoadError() {
  errorMsg.replaceChildren(document.createTextNode(t("library_load_error")));
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "load-more-btn";
  retry.textContent = t("retry");
  retry.addEventListener("click", main, { once: true });
  errorMsg.append(" ", retry);
  errorMsg.classList.remove("hidden");
}

async function main() {
  if (!slug) {
    titleEl.textContent = t("collection_not_specified");
    return;
  }

  errorMsg.classList.add("hidden");
  try {
    const res = await fetch(`/api/collections/${encodeURIComponent(slug)}`);
    if (res.status === 404) {
      titleEl.textContent = t("collection_not_found");
      return;
    }
    if (!res.ok) throw new Error("collection_unavailable");
    const collection = await res.json();
    if (!collection || !Array.isArray(collection.games)) throw new Error("invalid_collection");
    await loadFavoriteSlugs();
    titleEl.textContent = collection.name;
    document.title = `${collection.name} — FlashBack`;
    descEl.textContent = collection.description || "";

    emptyMsg.classList.toggle("hidden", collection.games.length > 0);
    for (const game of collection.games) grid.appendChild(buildGameCard(game));
  } catch (error) {
    titleEl.textContent = t("collection_load_error");
    descEl.textContent = "";
    emptyMsg.classList.add("hidden");
    showLoadError();
  }
}

document.getElementById("back-link").innerHTML = iconSvg("arrow-left") + " " + t("nav_collections");
initViewToggle(grid, document.getElementById("view-toggle"));
initThemeToggle(document.getElementById("theme-select"));
initLangToggle(document.getElementById("lang-select"));

function onLanguageChange() {
  document.getElementById("back-link").innerHTML = iconSvg("arrow-left") + " " + t("nav_collections");
  if (!errorMsg.classList.contains("hidden")) {
    titleEl.textContent = t("collection_load_error");
    showLoadError();
  }
}

main();
