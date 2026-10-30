# Windows native prebuilds

Provides console input setup, modifier-key state, and asynchronous text/image clipboard access. Links to `kernel32` and `user32`; no Node headers are required.

## Building

On Windows, install Visual Studio's "Desktop development with C++" workload, then run from the repository root to build x64 and arm64:

```sh
npm --prefix packages/tui run build:native:win32
```

For cross-builds or custom toolchains, provide MinGW-compatible compilers:

```sh
AMAZME_TUI_WIN32_TOOLCHAIN=mingw \
CC_X64=/path/to/x86_64-w64-mingw32-gcc \
CC_ARM64=/path/to/aarch64-w64-mingw32-gcc \
npm --prefix packages/tui run build:native:win32
```
