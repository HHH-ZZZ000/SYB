import { ApiClient } from "./services/api.js";
import { TelemetryStore } from "./services/telemetry.js";
import { loadPreferences } from "./services/preferences.js";
import { Navbar } from "./components/Navbar.js";
import { Sidebar } from "./components/Sidebar.js";
import { startRouter } from "./router.js";

const api = new ApiClient();
const store = new TelemetryStore(api, loadPreferences());
const navbar = Navbar(store),
  sidebar = Sidebar(store);
document.querySelector("#navbar").replaceWith(navbar.root);
document.querySelector("#sidebar").replaceWith(sidebar.root);
startRouter(document.querySelector("#page-content"), { store, api }, (path) =>
  sidebar.activate(path),
);
store.start();
window.addEventListener("pagehide", () => store.stop());
window.addEventListener("pageshow", (event) => {
  if (event.persisted) store.start();
});
