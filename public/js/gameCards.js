function hashHue(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
  return Math.abs(hash) % 360;
}

function buildGameCard(game) {
  const card = document.createElement("article");
  card.className = "card";

  const link = document.createElement("a");
  link.className = "card-link";
  link.href = `play?slug=${encodeURIComponent(game.slug)}`;

  const cover = document.createElement("div");
  cover.className = "card-cover";
  if (game.cover) {
    cover.classList.add("has-image");
    const img = document.createElement("img");
    img.src = `covers/${encodeURIComponent(game.slug)}.${encodeURIComponent(game.cover)}?v=${game.coverVersion || 0}`;
    img.alt = game.title;
    img.loading = "lazy";
    img.decoding = "async";
    cover.appendChild(img);
  } else {
    const hue = hashHue(game.slug);
    cover.style.setProperty("--hue1", `hsl(${hue}, 70%, 55%)`);
    cover.style.setProperty("--hue2", `hsl(${(hue + 60) % 360}, 70%, 55%)`);
    cover.textContent = game.title.slice(0, 1).toUpperCase();
  }

  const title = document.createElement("div");
  title.className = "card-title";
  title.textContent = game.title;
  link.append(cover, title);

  if (game.description) {
    const desc = document.createElement("div");
    desc.className = "card-description";
    desc.textContent = game.description;
    link.appendChild(desc);
  }

  card.append(link, createFavoriteButton(game.slug));
  return card;
}
