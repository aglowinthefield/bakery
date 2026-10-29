import { chromium } from "playwright";

// Loaded by `npm test` before every test file. Playwright waits 30s by default for a locator that never appears,
// and a UI test can wait several times, so one missing element stalled the suite for minutes. A wait that takes
// longer than 10s here, even with every test file running in parallel, means the element is not coming. Page loads
// keep 30s for a cold Vite server.
const launch = chromium.launch.bind(chromium);
chromium.launch = async (...args) => {
  const browser = await launch(...args);
  const newContext = browser.newContext.bind(browser);
  // Browser.newPage creates its context through this, so pages opened either way get the limit.
  browser.newContext = async (...options) => {
    const context = await newContext(...options);
    context.setDefaultTimeout(10_000);
    context.setDefaultNavigationTimeout(30_000);
    return context;
  };
  return browser;
};
