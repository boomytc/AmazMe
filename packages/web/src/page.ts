import { DesktopPage } from "./python-page.ts";

const page = new DesktopPage();
window.addEventListener("pagehide", () => page.dispose());
void page.start().catch(error => { page.renderer.setConnection(error instanceof Error ? error.message : String(error), "error"); });
