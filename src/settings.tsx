import { useState, type ReactNode } from "react";
import type { BakerySettings } from "./model.js";
import { settingsSections, type SettingsSection } from "./route.js";
import { themeFamilies, themeModes, themeParts } from "./themes.js";
import { UpdatesPanel } from "./update-notice.js";

const titles: Record<SettingsSection, { label: string; blurb: string }> = {
  general: {
    label: "General",
    blurb: "Runs, notifications and how cards open.",
  },
  appearance: { label: "Appearance", blurb: "Theme and density." },
  models: { label: "Models", blurb: "Which model each kind of Pi run uses." },
  updates: {
    label: "Updates",
    blurb: "The running version and anything waiting to install.",
  },
  server: {
    label: "Server",
    blurb: "The Bakery server this desktop app is connected to.",
  },
};

/** The desktop app marks the page; the browser has no server to switch. */
const inDesktopApp = () => "desktop" in document.documentElement.dataset;

/** A full page: a category sidebar on the left, the open category on the right. Preferences live in Bakery's local database. */
export function SettingsPage({
  section,
  onSection,
  settings,
  busy,
  error,
  saveSettings,
  setError,
  modelFields,
}: {
  section: SettingsSection;
  onSection: (next: SettingsSection) => void;
  settings: BakerySettings | null;
  busy: boolean;
  error: string;
  saveSettings: (patch: Partial<BakerySettings>) => void;
  setError: (message: string) => void;
  modelFields: ReactNode;
}) {
  return (
    <main className="page-fade min-w-0 flex-1">
      <header className="border-b border-border px-6 py-6 lg:px-10">
        <h1 className="text-[27px] font-semibold tracking-[-.05em]">
          Settings
        </h1>
      </header>
      <div className="flex flex-col gap-6 px-6 py-6 md:flex-row lg:px-10">
        <nav
          aria-label="Settings categories"
          className="flex shrink-0 gap-1 md:w-48 md:flex-col"
        >
          {settingsSections
            .filter((item) => item !== "server" || inDesktopApp())
            .map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => onSection(item)}
                aria-current={item === section ? "page" : undefined}
                className={`rounded-lg px-3 py-2 text-left text-sm ${item === section ? "bg-accent/50 font-medium" : "hover:bg-accent/30"}`}
              >
                {titles[item].label}
              </button>
            ))}
        </nav>
        <section
          className="max-w-2xl min-w-0 flex-1"
          aria-labelledby="settings-heading"
        >
          <h2 id="settings-heading" className="text-lg font-semibold">
            {titles[section].label}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {titles[section].blurb}
          </p>
          <div className="mt-6">
            {section === "general" && (
              <>
                <label className="flex items-start gap-3 text-sm">
                  <input
                    type="checkbox"
                    className="mt-1 accent-primary"
                    checked={settings?.confirmRunStart ?? false}
                    disabled={!settings || busy}
                    onChange={(event) =>
                      saveSettings({ confirmRunStart: event.target.checked })
                    }
                  />
                  <span>
                    Confirm before starting a run
                    <span className="mt-1 block text-xs text-muted-foreground">
                      When off, Start Pi run launches immediately and may use
                      paid model tokens.
                    </span>
                  </span>
                </label>
                <label className="mt-6 flex items-start gap-3 border-t border-border pt-5 text-sm">
                  <input
                    type="checkbox"
                    className="mt-1 accent-primary"
                    checked={settings?.notifyOnReview ?? false}
                    disabled={!settings || busy || !("Notification" in window)}
                    onChange={async (event) => {
                      if (!event.target.checked) {
                        saveSettings({ notifyOnReview: false });
                        return;
                      }
                      try {
                        const permission =
                          await Notification.requestPermission();
                        if (permission === "granted")
                          saveSettings({ notifyOnReview: true });
                        else
                          setError(
                            "Browser notification permission was not granted. Allow notifications for Bakery in your browser to enable them.",
                          );
                      } catch {
                        setError(
                          "The browser could not request notification permission.",
                        );
                      }
                    }}
                  />
                  <span>
                    Notify when a card enters Review
                    <span className="mt-1 block text-xs text-muted-foreground">
                      Browser notifications appear while this board page is
                      open. Your browser must allow notifications. Cards already
                      in Review when you open the page do not trigger one.
                    </span>
                  </span>
                </label>
                <DiscordWebhookField
                  key={settings?.discordWebhookUrl ?? ""}
                  value={settings?.discordWebhookUrl ?? ""}
                  disabled={!settings || busy}
                  onSave={(discordWebhookUrl) => saveSettings({ discordWebhookUrl })}
                />
                <fieldset
                  className="mt-6 border-t border-border pt-5 text-sm"
                  disabled={!settings || busy}
                >
                  <legend className="pt-5 font-medium">Cards</legend>
                  <label className="mt-3 flex cursor-pointer items-center gap-2">
                    <input
                      type="checkbox"
                      checked={settings?.showCardModels ?? false}
                      onChange={(event) =>
                        saveSettings({ showCardModels: event.target.checked })
                      }
                      className="accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                    />
                    Show the run and review model on each card
                  </label>
                </fieldset>
                <fieldset
                  className="mt-6 border-t border-border pt-5 text-sm"
                  disabled={!settings || busy}
                >
                  <legend className="pt-5 font-medium">
                    Card details layout
                  </legend>
                  <div className="mt-3 flex gap-5">
                    {(["dialog", "side"] as const).map((layout) => (
                      <label
                        key={layout}
                        className="flex cursor-pointer items-center gap-2"
                      >
                        <input
                          type="radio"
                          name="card-details-layout"
                          checked={settings?.cardDetailsLayout === layout}
                          onChange={() =>
                            saveSettings({ cardDetailsLayout: layout })
                          }
                          className="accent-primary"
                        />
                        {layout === "dialog" ? "Popup" : "Side panel"}
                      </label>
                    ))}
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    The side panel stays wide for review. On small screens it
                    opens full-screen.
                  </p>
                </fieldset>
                <p className="mt-6 border-t border-border pt-5 text-xs text-muted-foreground">
                  Auto pickup is set per repository. Use the edit button next to
                  a repository to change it.
                </p>
              </>
            )}
            {section === "appearance" && (
              <>
                <fieldset className="text-sm" disabled={!settings || busy}>
                  <legend className="pt-5 font-medium">Theme</legend>
                  {(() => {
                    const { family, mode } = themeParts(
                      settings?.theme ?? "default",
                    );
                    return (
                      <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-3">
                        <select
                          aria-label="Theme"
                          value={family.id}
                          onChange={(event) => {
                            const next = themeFamilies.find(
                              (item) => item.id === event.target.value,
                            )!;
                            const theme = next[mode] ?? next.dark ?? next.light;
                            if (theme) saveSettings({ theme });
                          }}
                          className="rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
                        >
                          {themeFamilies.map((item) => (
                            <option key={item.id} value={item.id}>
                              {item.label}
                            </option>
                          ))}
                        </select>
                        <div
                          className="flex gap-5"
                          role="group"
                          aria-label="Mode"
                        >
                          {themeModes.map((item) => {
                            const theme = family[item];
                            return (
                              <label
                                key={item}
                                title={
                                  theme
                                    ? undefined
                                    : `${family.label} has no ${item === "system" ? "light and dark pair" : item + " variant"}`
                                }
                                className="flex cursor-pointer items-center gap-2 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50"
                              >
                                <input
                                  type="radio"
                                  name="theme-mode"
                                  disabled={!theme}
                                  checked={mode === item}
                                  onChange={() =>
                                    theme && saveSettings({ theme })
                                  }
                                  className="accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                                />
                                {item[0].toUpperCase() + item.slice(1)}
                              </label>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })()}
                </fieldset>
                <fieldset
                  className="mt-6 border-t border-border pt-5 text-sm"
                  disabled={!settings || busy}
                >
                  <legend className="pt-5 font-medium">Density</legend>
                  <div className="mt-3 flex gap-5">
                    {(["compact", "default", "cozy"] as const).map(
                      (density) => (
                        <label
                          key={density}
                          className="flex cursor-pointer items-center gap-2"
                        >
                          <input
                            type="radio"
                            name="density"
                            checked={
                              (settings?.density ?? "default") === density
                            }
                            onChange={() => saveSettings({ density })}
                            className="accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                          />
                          {density === "compact"
                            ? "Compact"
                            : density === "cozy"
                              ? "Cozy"
                              : "Default"}
                        </label>
                      ),
                    )}
                  </div>
                </fieldset>
              </>
            )}
            {section === "models" && (
              <div className="text-sm">
                <div className="font-medium">Pi models</div>
                <p className="mt-2 text-xs text-muted-foreground">
                  Model and thinking level for each kind of Pi run. Blank fields
                  use Pi's own default. A repository can override these in its
                  edit dialog.
                </p>
                {modelFields}
              </div>
            )}
            {section === "updates" && <UpdatesPanel />}
            {section === "server" && (
              <div className="text-sm">
                {inDesktopApp() ? (
                  <>
                    <div className="font-medium">Connected to</div>
                    <p className="mt-1 font-mono text-xs text-muted-foreground">
                      {location.origin}
                    </p>
                    {/* The desktop app intercepts this link and opens its native connection window. */}
                    <a
                      href="/__desktop/connection"
                      className="mt-4 inline-block rounded-md border border-border px-3 py-1.5 hover:bg-accent/30"
                    >
                      Change server…
                    </a>
                  </>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Only the desktop app connects to a server.
                  </p>
                )}
              </div>
            )}
          </div>
          {error && (
            <p role="alert" className="mt-3 text-sm text-destructive">
              {error}
            </p>
          )}
        </section>
      </div>
    </main>
  );
}

function DiscordWebhookField({ value, disabled, onSave }: { value: string; disabled: boolean; onSave: (url: string) => void }) {
  const [draft, setDraft] = useState(value);
  return (
    <label className="mt-6 block border-t border-border pt-5 text-sm">
      <span className="font-medium">Discord webhook</span>
      <input
        type="password"
        autoComplete="off"
        spellCheck={false}
        className="mt-3 block w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
        placeholder="https://discord.com/api/webhooks/..."
        value={draft}
        disabled={disabled}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => { if (draft.trim() !== value) onSave(draft.trim()); }}
      />
      <span className="mt-1 block text-xs text-muted-foreground">
        Bakery posts to this channel when a run finishes. Leave empty to turn it off (BAKERY_DISCORD_WEBHOOK_URL is used if set).
      </span>
    </label>
  );
}
