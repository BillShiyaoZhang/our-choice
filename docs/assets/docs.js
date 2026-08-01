const search = document.querySelector("[data-doc-search]");
const sections = [...document.querySelectorAll("[data-doc-section]")];
const emptyState = document.querySelector("[data-search-empty]");
const clearSearch = document.querySelector("[data-clear-search]");
const sidebar = document.querySelector("[data-doc-sidebar]");
const backdrop = document.querySelector("[data-sidebar-backdrop]");
const openMenu = document.querySelector("[data-menu-open]");
const closeMenu = document.querySelector("[data-menu-close]");
const navLinks = [...document.querySelectorAll(".docs-nav a")];

function normalize(value) {
  return value.toLocaleLowerCase("zh-CN").replace(/\s+/g, " ").trim();
}

function filterSections() {
  const query = normalize(search?.value ?? "");
  let visible = 0;
  sections.forEach((section) => {
    const content = normalize(`${section.textContent} ${section.dataset.keywords ?? ""}`);
    const matches = !query || content.includes(query);
    section.hidden = !matches;
    if (matches) visible += 1;
  });
  if (emptyState) emptyState.hidden = visible !== 0;
}

search?.addEventListener("input", filterSections);
clearSearch?.addEventListener("click", () => {
  if (!search) return;
  search.value = "";
  filterSections();
  search.focus();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "/" && document.activeElement?.tagName !== "INPUT") {
    event.preventDefault();
    search?.focus();
  }
  if (event.key === "Escape") closeSidebar();
});

function openSidebar() {
  sidebar?.classList.add("is-open");
  backdrop?.removeAttribute("hidden");
  openMenu?.setAttribute("aria-expanded", "true");
  closeMenu?.focus();
}

function closeSidebar() {
  sidebar?.classList.remove("is-open");
  backdrop?.setAttribute("hidden", "");
  openMenu?.setAttribute("aria-expanded", "false");
}

openMenu?.addEventListener("click", openSidebar);
closeMenu?.addEventListener("click", closeSidebar);
backdrop?.addEventListener("click", closeSidebar);
navLinks.forEach((link) => link.addEventListener("click", closeSidebar));

document.querySelectorAll("[data-copy-target]").forEach((button) => {
  button.addEventListener("click", async () => {
    const target = document.getElementById(button.dataset.copyTarget);
    if (!target) return;
    try {
      await navigator.clipboard.writeText(target.innerText);
      button.textContent = "已复制";
    } catch {
      button.textContent = "请手动复制";
    }
    window.setTimeout(() => { button.textContent = "复制"; }, 1800);
  });
});

if ("IntersectionObserver" in window) {
  const observer = new IntersectionObserver((entries) => {
    const current = entries.find((entry) => entry.isIntersecting);
    if (!current) return;
    navLinks.forEach((link) => {
      const active = link.getAttribute("href") === `#${current.target.id}`;
      link.classList.toggle("is-active", active);
      if (active) link.setAttribute("aria-current", "location");
      else link.removeAttribute("aria-current");
    });
  }, { rootMargin: "-20% 0px -70%", threshold: 0 });
  sections.forEach((section) => observer.observe(section));
}
