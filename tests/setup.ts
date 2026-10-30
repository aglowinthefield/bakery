import { chromium, webkit } from "playwright";

// Tests that spawn `server/index.ts` poll http://127.0.0.1:<port>. When the suite runs inside a Bakery agent, the
// environment carries Bakery's own remote-hosting settings, which would bind the test server to another address.
delete process.env.BAKERY_HOST;
delete process.env.BAKERY_ALLOWED_HOSTS;

// Loaded by `npm test` before every test file. Playwright waits 30s by default for a locator that never appears,
// and a UI test can wait several times, so one missing element stalled the suite for minutes. A wait that takes
// longer than 10s here, even with every test file running in parallel, means the element is not coming. Page loads
// keep 30s for a cold Vite server.
//
// On macOS the tests run in WebKit: headless Chromium falls back to software GPU rendering there and pegs every core.
// Tests keep calling `chromium.launch()`; set BAKERY_TEST_BROWSER=chromium (in the shell, or at the top of a test file
// that needs Chromium-only features such as clipboard permissions) to get real Chromium back.
const launchChromium = chromium.launch.bind(chromium);
chromium.launch = async (...args) => {
  const useWebkit = process.platform === "darwin" && process.env.BAKERY_TEST_BROWSER !== "chromium";
  const browser = await (useWebkit ? webkit.launch() : launchChromium(...args));
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
