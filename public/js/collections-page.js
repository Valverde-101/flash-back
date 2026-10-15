const grid = document.getElementById("grid");
const emptyMsg = document.getElementById("empty");
const errorMsg = document.getElementById("load-error");

let lastCollections = [];

function hashHue(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  return Math.abs(hash) % 360;
}

function buildCollectionCard(collection) {
  const card = document.createElement("a");
  card.className = "card";
  card.href = `collection?slug=${encodeURIComponent(collection.slug)}`;

  const cover = document.createElement("div");
  cover.className = "card-cover";

  if (collection.cover) {
    cover.classList.add("has-image");
    const img = document.createElement("img");
    img.src = `covers/collections/${collection.slug}.${collection.cover}?v=${collection.coverVersion || 0}`;
    img.alt = collection.name;
    cover.appendChild(img);
  } else {
    const hue = hashHue(collection.slug);
    cover.style.setProperty("--hue1", `hsl(${hue}, 70%, 55%)`);
    cover.style.setProperty("--hue2", `hsl(${(hue + 60) % 360}, 70%, 55%)`);
    cover.textContent = collection.name.slice(0, 1).toUpperCase();
  }

  const title = document.createElement("div");
  title.className = "card-title";
  title.textContent = collection.name;

  const count = document.createElement("div");
  count.className = "card-subtitle";
  count.textContent = tCount("games_count", collection.count);

  card.append(cover, title, count);

  if (collection.description) {
    const desc = document.createElement("div");
    desc.className = "card-description";
    desc.textContent = collection.description;
    card.appendChild(desc);
  }

  return card;
}

function render() {
  grid.innerHTML = "";
  emptyMsg.classList.toggle("hidden", lastCollections.length > 0);
  for (const collection of lastCollections) {
    grid.appendChild(buildCollectionCard(collection));
  }
}

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
  errorMsg.classList.add("hidden");
  try {
    const res = await fetch("/api/collections");
    if (!res.ok) throw new Error("collections_unavailable");
    const data = await res.json();
    if (!Array.isArray(data)) throw new Error("invalid_collections");
    lastCollections = data;
    emptyMsg.classList.remove("error");
    render();
  } catch (error) {
    grid.replaceChildren();
    emptyMsg.classList.add("hidden");
    errorMsg.textContent = t("library_load_error");
    showLoadError();
  }
}

initViewToggle(grid, document.getElementById("view-toggle"));
initThemeToggle(document.getElementById("theme-select"));
initLangToggle(document.getElementById("lang-select"));

function onLanguageChange() {
  if (errorMsg.classList.contains("hidden")) render();
  else showLoadError();
}

main();
