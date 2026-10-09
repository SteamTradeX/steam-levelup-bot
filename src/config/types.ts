/**
 * The shape of a setting declaration. A setting is declared once, in
 * settings.ts, and from that one declaration come its default, the check
 * settings.json gets before anything is applied, and its documentation.
 */

/** Everything a value can be. Deliberately small. */
export type SettingValue = string | number | boolean | readonly string[];

/** Which part of the bot a setting belongs to, for the README table. */
export type SettingGroup = "identity" | "currencies" | "rates" | "stock" | "limits" | "filters" | "providers";

/**
 * A value's type, and the constraints that go with it.
 *
 * Hand written rather than reached for a validation library: one fewer
 * dependency to keep up to date.
 */
export type SettingKind =
  | { readonly kind: "boolean" }
  | { readonly kind: "integer"; readonly min?: number; readonly max?: number; readonly unit?: string }
  | { readonly kind: "decimal"; readonly min?: number; readonly max?: number; readonly places?: number }
  | {
      readonly kind: "text";
      readonly maxLength?: number;
      /** Tested against the whole value. Anchored patterns only. */
      readonly pattern?: RegExp;
      /** What to say when the pattern fails, in words a customer can act on. */
      readonly patternHint?: string;
    }
  | { readonly kind: "url" }
  | { readonly kind: "choice"; readonly values: readonly string[] }
  | { readonly kind: "steamId" }
  | { readonly kind: "steamIdList"; readonly maxItems?: number }
  | { readonly kind: "commandList" }
  | { readonly kind: "textList"; readonly maxItems?: number };

export type SettingDef = {
  /** Stable. A key in settings.json is matched against this exactly. */
  readonly key: string;
  readonly group: SettingGroup;
  readonly type: SettingKind;
  readonly default: SettingValue;
  /** A key or password: never logged, never shown back. See `Secret` in `secret.ts`. */
  readonly secret?: boolean;
  /** The schema version that introduced it. */
  readonly since: number;
  /** A short name for the setting. */
  readonly label: string;
  /** What it does, in plain words for the owner. */
  readonly help: string;
};

/** A validation complaint, naming the setting it is about. */
export type Issue = {
  /** The setting the complaint is about. Empty for whole document problems. */
  readonly key: string;
  readonly message: string;
};

export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly Issue[] };
