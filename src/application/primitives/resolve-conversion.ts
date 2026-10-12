import { resolveAttribute } from '../../domain/attributes/index.js';
import {
  type CrlfAction,
  type EolSettings,
  resolveCrlfAction,
} from '../../domain/eol/crlf-action.js';
import type { FilePath } from '../../domain/objects/object-id.js';
import type { Context } from '../../ports/context.js';
import { readConfig } from './config-read.js';
import { smudgesInCore } from './internal/apply-smudge-filter.js';
import { assertValidBooleanConfigInSection } from './internal/boolean-config-guard.js';
import type { AttributeProvider } from './internal/read-gitattributes.js';
import { type FilterChoice, filterChoiceFromSources } from './resolve-filter-driver.js';

export interface Conversion {
  readonly filter: FilterChoice;
  readonly crlf: CrlfAction;
  readonly ident: boolean;
}

export const IDENTITY_CONVERSION: Conversion = {
  filter: { kind: 'identity' },
  crlf: 'binary',
  ident: false,
};

/** Absent-key defaults of git: `core.autocrlf` off, `core.safecrlf` warn, LF native. */
export const readEolSettings = async (ctx: Context): Promise<EolSettings> => {
  const { core = {} } = await readConfig(ctx);
  return {
    autoCrlf: core.autoCrlf ?? false,
    ...(core.eol !== undefined && { coreEol: core.eol }),
    safeCrlf: core.safeCrlf ?? 'warn',
    nativeEol: ctx.nativeEol ?? 'lf',
  };
};

export const isIdentityConversion = (conversion: Conversion): boolean =>
  conversion.filter.kind === 'identity' && conversion.crlf === 'binary' && !conversion.ident;

/** git `classify_conv_attrs` / `get_stream_filter`: only these classes cannot stream. */
export const convertsInCore = (conversion: Conversion): boolean =>
  smudgesInCore(conversion.filter) || conversion.crlf === 'auto' || conversion.crlf === 'auto-crlf';

const validateFilterSections = (ctx: Context): Promise<void> =>
  assertValidBooleanConfigInSection(ctx, 'filter', ['required'], { requireSubsection: true });

export const resolveConversion = async (
  ctx: Context,
  provider: AttributeProvider,
  path: FilePath,
  settings: EolSettings,
  options: { readonly eagerSectionValidation?: boolean } = {},
): Promise<Conversion> => {
  if (options.eagerSectionValidation === true) await validateFilterSections(ctx);
  const { sources, macros } = await provider.sourcesForPath(path);
  if (sources.length === 0 && settings.autoCrlf === false) return IDENTITY_CONVERSION;
  const attribute = (name: string) => resolveAttribute(sources, path, name, macros);
  return {
    filter: await filterChoiceFromSources(ctx, sources, macros, path),
    crlf: resolveCrlfAction(
      { text: attribute('text'), crlf: attribute('crlf'), eol: attribute('eol') },
      settings,
    ),
    ident: attribute('ident') === true,
  };
};
