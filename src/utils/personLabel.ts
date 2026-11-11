/**
 * @description How a person is named to people in a topic message: `@alice (Alice Smith)` when they have a username,
 * their name alone otherwise. Plain text — posted without a parse mode, so a name needs no escaping.
 */

/** What the bot knows of a person for a label. */
export interface PersonLabelSource {
  /** Without a leading `@`. */
  username?: string;
  name: string;
}

/** @description `@alice (Alice Smith)`, or `Alice Smith`; a username with no name reads as `@alice`. */
export function formatPersonLabel(person: PersonLabelSource): string {
  const name = person.name.trim();
  if (!person.username) return name;
  return name ? `@${person.username} (${name})` : `@${person.username}`;
}
