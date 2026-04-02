import { log } from "./lib/logger";
log("[boot] index.ts loading");

import "./components/tag-input";
import "./components/autocomplete-input";
import "./components/recipe-preview";
import { initTheme } from "./lib/themes";
import { initAuth } from "./ui/auth";
import { initAccount } from "./ui/account";
import { initBooks } from "./ui/books";
import { initShare } from "./ui/share";
import { initRecipes } from "./ui/recipes";
import { initSyncStatus } from "./ui/sync-status";
import { showAccountPage } from "./ui/account";
import { logout } from "./ui/auth";

// -- Init theme --
initTheme();

// -- Profile menu --
const profileBtn = document.getElementById("profile-btn") as HTMLButtonElement;
const profileMenu = document.getElementById("profile-menu") as HTMLElement;
const menuLogout = document.getElementById("menu-logout") as HTMLButtonElement;
const menuAccount = document.getElementById("menu-account") as HTMLButtonElement;
const menuTheme = document.getElementById("menu-theme") as HTMLButtonElement;

profileBtn.addEventListener("click", (e) => { e.stopPropagation(); profileMenu.classList.toggle("open"); });
menuLogout.addEventListener("click", () => { profileMenu.classList.remove("open"); logout(); });
menuAccount.addEventListener("click", () => { profileMenu.classList.remove("open"); showAccountPage(); });
menuTheme.addEventListener("click", () => { profileMenu.classList.remove("open"); showAccountPage(); });

// -- Init modules --
initAuth();
initAccount();
initBooks();
initShare();
initRecipes();
initSyncStatus();

// -- Keyboard shortcuts --
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "k") {
    e.preventDefault();
    const search = document.getElementById("search-input") as HTMLInputElement;
    search.focus();
    search.select();
  }
});

// -- Service worker --
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/service-worker.js").catch(console.error);
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data?.type === "update-available") {
      const banner = document.createElement("div"); banner.className = "update-banner";
      banner.textContent = "New version available. ";
      const btn = document.createElement("button"); btn.textContent = "Refresh"; btn.addEventListener("click", () => location.reload());
      banner.appendChild(btn); document.body.prepend(banner);
    }
  });
  // Check for updates when the user returns to the tab/app
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      navigator.serviceWorker.controller?.postMessage("visibility-visible");
      // Also trigger the browser's built-in SW update check
      navigator.serviceWorker.getRegistration().then((reg) => reg?.update());
    }
  });
  // Check on first load once the SW is ready
  navigator.serviceWorker.ready.then((reg) => {
    reg.active?.postMessage("check-update");
  });
}
