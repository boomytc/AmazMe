#!/usr/bin/env node

// The product page is served by the Python backend. This launcher no longer starts the old web host.
console.error("old_web_host_removed");
console.error("网页由 Python 后端提供，不再启动旧宿主");
process.exitCode = 1;
