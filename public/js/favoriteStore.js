const favoriteSlugs = new Set();
let favoritesReady = false;

async function loadFavoriteSlugs() {
  if (favoritesReady) return favoriteSlugs;
  try {
    const response = await fetch("/api/favorites");
    if (!response.ok) throw new Error("favorites_unavailable");
    const data = await response.json();
    favoriteSlugs.clear();
    for (const slug of data.slugs || []) favoriteSlugs.add(slug);
    favoritesReady = true;
  } catch (error) {
    // The UI remains usable if the server is temporarily unavailable.
  }
  return favoriteSlugs;
}

function isFavorite(slug) {
  return favoriteSlugs.has(slug);
}

function syncFavoriteButtons(slug) {
  for (const button of document.querySelectorAll(`[data-favorite-slug="${CSS.escape(slug)}"]`)) {
    const active = favoriteSlugs.has(slug);
    button.classList.toggle("is-favorite", active);
    button.setAttribute("aria-pressed", String(active));
    button.setAttribute("aria-label", active ? t("favorite_remove") : t("favorite_add"));
    button.title = active ? t("favorite_remove") : t("favorite_add");
    button.innerHTML = iconSvg("star");
  }
}

function createFavoriteButton(slug) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "favorite-toggle";
  button.dataset.favoriteSlug = slug;
  button.setAttribute("aria-pressed", String(isFavorite(slug)));
  button.setAttribute("aria-label", isFavorite(slug) ? t("favorite_remove") : t("favorite_add"));
  button.title = isFavorite(slug) ? t("favorite_remove") : t("favorite_add");
  button.innerHTML = iconSvg("star");
  if (isFavorite(slug)) button.classList.add("is-favorite");

  button.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (button.disabled) return;
    button.disabled = true;
    const wasFavorite = isFavorite(slug);
    try {
      const response = await fetch(`/api/favorites/${encodeURIComponent(slug)}`, {
        method: wasFavorite ? "DELETE" : "POST",
        headers: { "Content-Type": "application/json" },
        body: wasFavorite ? undefined : "{}",
      });
      if (!response.ok) throw new Error("favorite_update_failed");
      if (wasFavorite) favoriteSlugs.delete(slug);
      else favoriteSlugs.add(slug);
      favoritesReady = true;
      syncFavoriteButtons(slug);
      document.dispatchEvent(new CustomEvent("flashback:favorites-changed", { detail: { slug, favorite: !wasFavorite } }));
    } catch (error) {
      alert(t("favorite_error"));
    } finally {
      button.disabled = false;
    }
  });
  return button;
}

window.addEventListener("flashback:language-changed", () => {
  for (const button of document.querySelectorAll("[data-favorite-slug]")) {
    const active = favoriteSlugs.has(button.dataset.favoriteSlug);
    button.setAttribute("aria-label", active ? t("favorite_remove") : t("favorite_add"));
    button.title = active ? t("favorite_remove") : t("favorite_add");
  }
});
