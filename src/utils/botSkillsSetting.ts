/**
 * @description The values `settings.json`'s `botSkills` takes — apart from `utils/botSkills.ts` because that module reads
 * the file through `instanceSettings.ts`, which needs the values for its schema (an import cycle otherwise).
 */

export const botSkillsSettingValues = ['on', 'off'] as const;
export type BotSkillsSetting = (typeof botSkillsSettingValues)[number];
