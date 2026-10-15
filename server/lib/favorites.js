const { FAVORITES_PATH } = require("./paths");
const { readJson, writeJson } = require("./jsonStore");

function isFavoriteList(value) {
  return Array.isArray(value) && value.every((slug) => typeof slug === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug));
}

function listFavorites() {
  return [...new Set(readJson(FAVORITES_PATH, [], isFavoriteList))];
}

function addFavorite(slug) {
  const favorites = listFavorites();
  if (!favorites.includes(slug)) favorites.push(slug);
  writeJson(FAVORITES_PATH, favorites);
  return favorites;
}

function removeFavorite(slug) {
  const favorites = listFavorites().filter((item) => item !== slug);
  writeJson(FAVORITES_PATH, favorites);
  return favorites;
}

module.exports = { listFavorites, addFavorite, removeFavorite };
