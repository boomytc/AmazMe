import { EXIT_HINT, EXIT_WINDOW_MS } from "@amazme/tui";

/** First Ctrl-C arms the window. A second one inside it exits. SIGTERM exits immediately. */
export function waitForSecondInterrupt(): Promise<void> {
  return new Promise((resolve) => {
    let armedAt = 0;
    const finish = (): void => {
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", finish);
      resolve();
    };
    const onInterrupt = (): void => {
      const now = Date.now();
      if (armedAt !== 0 && now - armedAt <= EXIT_WINDOW_MS) {
        finish();
        return;
      }
      armedAt = now;
      process.stderr.write(`${EXIT_HINT}\n`);
    };
    process.on("SIGINT", onInterrupt);
    process.on("SIGTERM", finish);
  });
}
