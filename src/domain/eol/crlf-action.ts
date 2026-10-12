import type { AttributeValue } from '../attributes/attribute-value.js';

export type AutoCrlf = boolean | 'input';
export type CoreEol = 'lf' | 'crlf' | 'native';
export type LineEnding = 'lf' | 'crlf';
export type CrlfAction =
  | 'binary'
  | 'text-input'
  | 'text-crlf'
  | 'auto'
  | 'auto-input'
  | 'auto-crlf';

export interface EolSettings {
  readonly autoCrlf: AutoCrlf;
  readonly coreEol?: CoreEol;
  readonly safeCrlf: boolean | 'warn';
  readonly nativeEol: LineEnding;
}

export interface ConversionAttributes {
  readonly text: AttributeValue;
  readonly crlf: AttributeValue;
  readonly eol: AttributeValue;
}

type DeclaredAction =
  | Exclude<CrlfAction, 'auto-input' | 'auto-crlf' | 'text-crlf'>
  | 'text'
  | undefined;
type EolAdjustedAction = DeclaredAction | 'auto-input' | 'auto-crlf' | 'text-crlf';

const actionFromValue = (value: AttributeValue): DeclaredAction => {
  if (value === true) return 'text';
  if (value === false) return 'binary';
  if (value === 'unspecified') return undefined;
  if (value.set === 'input') return 'text-input';
  if (value.set === 'auto') return 'auto';
  return undefined;
};

const eolValue = (eol: AttributeValue): LineEnding | undefined => {
  if (typeof eol === 'boolean' || eol === 'unspecified') return undefined;
  if (eol.set === 'lf' || eol.set === 'crlf') return eol.set;
  return undefined;
};

const applyEolAttribute = (action: DeclaredAction, eol: AttributeValue): EolAdjustedAction => {
  const lineEnding = eolValue(eol);
  if (action === 'binary' || lineEnding === undefined) return action;
  if (action === 'auto') return lineEnding === 'lf' ? 'auto-input' : 'auto-crlf';
  return lineEnding === 'lf' ? 'text-input' : 'text-crlf';
};

const textEolIsCrlf = (settings: EolSettings): boolean => {
  if (settings.autoCrlf === true) return true;
  if (settings.autoCrlf === 'input') return false;
  if (settings.coreEol === 'crlf') return true;
  if (settings.coreEol === 'lf') return false;
  return settings.nativeEol === 'crlf';
};

const fromAutoCrlf = (autoCrlf: AutoCrlf): CrlfAction => {
  if (autoCrlf === false) return 'binary';
  return autoCrlf === 'input' ? 'auto-input' : 'auto-crlf';
};

const settleUndeclared = (action: EolAdjustedAction, settings: EolSettings): CrlfAction => {
  if (action === 'text') return textEolIsCrlf(settings) ? 'text-crlf' : 'text-input';
  return action ?? fromAutoCrlf(settings.autoCrlf);
};

export const resolveCrlfAction = (
  attrs: ConversionAttributes,
  settings: EolSettings,
): CrlfAction => {
  const declared = actionFromValue(attrs.text) ?? actionFromValue(attrs.crlf);
  return settleUndeclared(applyEolAttribute(declared, attrs.eol), settings);
};

export const outputLineEnding = (
  action: CrlfAction,
  settings: EolSettings,
): LineEnding | undefined => {
  if (action === 'binary') return undefined;
  if (action === 'auto') return textEolIsCrlf(settings) ? 'crlf' : 'lf';
  return action === 'text-crlf' || action === 'auto-crlf' ? 'crlf' : 'lf';
};
