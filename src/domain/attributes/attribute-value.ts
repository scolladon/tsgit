/**
 * The four states a git attribute can resolve to (`gitattributes(5)`):
 *
 * - `true`          — set (`name`)
 * - `false`         — unset (`-name`)
 * - `'unspecified'` — explicitly unspecified (`!name`)
 * - `{ set: value }`— set to a string value (`name=value`)
 */
export type AttributeValue = true | false | 'unspecified' | { readonly set: string };
