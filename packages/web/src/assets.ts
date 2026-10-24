import { fileURLToPath } from "node:url";

/** Shared desktop icons; the HTTP page and boot protocol come from the Python package. */
export const PAGE_DIRECTORY = fileURLToPath(new URL("./page/", import.meta.url));
