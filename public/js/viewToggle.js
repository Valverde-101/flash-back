// Shared grid/list view toggle, used by /, /collections and /collection.
const VIEW_STORAGE_KEY = "flashback:view-mode";

function initViewToggle(gridEl, buttonEl) {
  function apply(mode) {
    gridEl.classList.toggle("list-view", mode === "list");
    buttonEl.innerHTML = mode === "list"
      ? iconSvg("layout-grid") + " " + t("view_grid")
      : iconSvg("list") + " " + t("view_list");
    buttonEl.dataset.mode = mode;
  }

  buttonEl.addEventListener("click", () => {
    const next = buttonEl.dataset.mode === "list" ? "grid" : "list";
    localStorage.setItem(VIEW_STORAGE_KEY, next);
    apply(next);
  });

  apply(localStorage.getItem(VIEW_STORAGE_KEY) === "list" ? "list" : "grid");
}

window.addEventListener("flashback:language-changed", () => {
  const button = document.querySelector(".view-toggle-btn");
  if (!button) return;
  button.innerHTML = button.dataset.mode === "list"
    ? iconSvg("layout-grid") + " " + t("view_grid")
    : iconSvg("list") + " " + t("view_list");
});
