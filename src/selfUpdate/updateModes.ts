/**
 * @name AutoUpdateMode
 * @description How an instance treats a new charness version: `on` installs it by itself when the bot is idle,
 * `notify` only says it is out (a button installs it), `off` never looks. Persisted as `autoUpdate` in `settings.json`.
 */
export const autoUpdateModes = ['on', 'notify', 'off'] as const;
export type AutoUpdateMode = (typeof autoUpdateModes)[number];

/** @description What `autoUpdate` means while `settings.json` does not set it. */
export const defaultAutoUpdateMode: AutoUpdateMode = 'on';

/** @description What `whatsNew` means while `settings.json` does not set it. */
export const defaultWhatsNew = true;
