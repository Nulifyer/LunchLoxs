import { log } from "./lib/logger";
log("[boot] index.ts loading");

import { initTheme } from "./lib/themes";
import { initAuth } from "./ui/auth";
import { initAccount } from "./ui/account";
import { initBooks } from "./ui/books";
import { initShare } from "./ui/share";
import { initRecipes } from "./ui/recipes";
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
}
