import { resolveAttribute } from '../../domain/attributes/index.js';
import {
  type CrlfAction,
  type EolSettings,
  resolveCrlfAction,
} from '../../domain/eol/crlf-action.js';
import type { FilePath } from '../../domain/objects/object-id.js';
import type { Context } from '../../ports/context.js';
import { type ParsedConfig, readConfig } from './config-read.js';
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

const settingsByConfig = new WeakMap<ParsedConfig, EolSettings>();

/**
 * Absent-key defaults of git: `core.autocrlf` off, `core.safecrlf` warn, LF native.
 * One object per parsed config, so a command comparing many entries builds it once;
 * the config cache dropping its parse is what retires it.
 */
export const readEolSettings = async (ctx: Context): Promise<EolSettings> => {
  const config = await readConfig(ctx);
  const nativeEol = ctx.nativeEol ?? 'lf';
  const memoised = settingsByConfig.get(config);
  if (memoised?.nativeEol === nativeEol) return memoised;
  const { core = {} } = config;
  const settings: EolSettings = {
    autoCrlf: core.autoCrlf ?? false,
    ...(core.eol !== undefined && { coreEol: core.eol }),
    safeCrlf: core.safeCrlf ?? 'warn',
    nativeEol,
  };
  settingsByConfig.set(config, settings);
  return settings;
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
  options: {
    readonly eagerSectionValidation?: boolean;
    /** `false` is the caller's proof that no `[filter "<d>"]` section exists: nothing to validate or resolve. */
    readonly filterDriversConfigured?: boolean;
  } = {},
): Promise<Conversion> => {
  const noDrivers = options.filterDriversConfigured === false;
  if (options.eagerSectionValidation === true && !noDrivers) await validateFilterSections(ctx);
  const { sources, macros } = await provider.sourcesForPath(path);
  if (sources.length === 0 && settings.autoCrlf === false) return IDENTITY_CONVERSION;
  const attribute = (name: string) => resolveAttribute(sources, path, name, macros);
  return {
    filter: noDrivers
      ? IDENTITY_CONVERSION.filter
      : await filterChoiceFromSources(ctx, sources, macros, path),
    crlf: resolveCrlfAction(
      { text: attribute('text'), crlf: attribute('crlf'), eol: attribute('eol') },
      settings,
    ),
    ident: attribute('ident') === true,
  };
};
