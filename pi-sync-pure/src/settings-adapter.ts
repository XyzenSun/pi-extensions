import {
  SYNC_PACKAGE_SOURCE,
  type FileAdapter,
} from "./adapters.ts";

export const SETTINGS_WHITELIST: readonly string[] = [
  "defaultProvider", "defaultModel", "defaultThinkingLevel", "thinkingBudgets", "theme",
  "retry", "compaction", "branchSummary", "warnings", "transport", "steeringMode",
  "followUpMode", "httpIdleTimeoutMs", "websocketConnectTimeoutMs", "enabledModels",
  "defaultTools", "doubleEscapeAction", "treeFilterMode", "editorPaddingX", "outputPad",
  "autocompleteMaxVisible", "showHardwareCursor", "markdown", "terminal", "images", "tuiMode",
  "fullscreenExitOutput", "fullscreenScrollbar", "packages",
];

const whitelist = new Set(SETTINGS_WHITELIST);

type Settings = Record<string, unknown>;

function parse(content: Buffer): Settings | undefined {
  try {
    const value: unknown = JSON.parse(content.toString("utf8"));
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Settings {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function packageSource(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  return isRecord(value) && typeof value.source === "string" ? value.source : undefined;
}

export function isPortablePackageSource(source: string): boolean {
  if (!source || /[\u0000-\u001f\u007f]/.test(source)) return false;
  if (/^(?:file:|\.\.?[\\/]|[\\/]|~[\\/])/i.test(source)) return false;
  return /^(?:npm:|git:|https?:\/\/|ssh:\/\/)/i.test(source);
}

function project(settings: Settings): Settings {
  return Object.fromEntries(Object.entries(settings).filter(([key]) => whitelist.has(key)));
}

function nonWhitelisted(settings: Settings): Settings {
  return Object.fromEntries(Object.entries(settings).filter(([key]) => !whitelist.has(key)));
}

function filterPackages(settings: Settings): Settings {
  if (!Array.isArray(settings.packages)) return settings;
  return {
    ...settings,
    packages: settings.packages.filter((entry) => {
      const source = packageSource(entry);
      return source !== undefined && isPortablePackageSource(source);
    }),
  };
}

function ensurePlugin(settings: Settings): Settings {
  const packages = Array.isArray(settings.packages) ? settings.packages : [];
  return packages.some((entry) => packageSource(entry) === SYNC_PACKAGE_SOURCE)
    ? settings
    : { ...settings, packages: [...packages, SYNC_PACKAGE_SOURCE] };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonicalize(item)]));
}

function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

function serialize(settings: Settings): Buffer {
  return Buffer.from(`${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

function localOnlyPackages(local: Settings, repository: Settings): unknown[] {
  if (!Array.isArray(local.packages)) return [];
  const repositoryPackages = Array.isArray(repository.packages) ? repository.packages : [];
  const seen = new Set(repositoryPackages.map((entry) => JSON.stringify(entry)));
  return local.packages.filter((entry) => {
    const source = packageSource(entry);
    return source !== undefined && !isPortablePackageSource(source) && !seen.has(JSON.stringify(entry));
  });
}

export const settingsAdapter: FileAdapter = {
  transformToRepository(local) {
    const settings = parse(local);
    if (!settings) return local;
    const transformed = ensurePlugin(filterPackages(project(settings)));
    return equal(transformed, settings) ? local : serialize(transformed);
  },

  transformToLocal(repository, local) {
    const repositorySettings = parse(repository);
    if (!repositorySettings) return repository;
    const localSettings = parse(local) ?? {};
    const projectedRepository = project(repositorySettings);
    const localPackages = localOnlyPackages(localSettings, projectedRepository);
    const merged: Settings = {
      ...nonWhitelisted(localSettings),
      ...projectedRepository,
    };
    if (localPackages.length > 0) {
      merged.packages = [
        ...(Array.isArray(projectedRepository.packages) ? projectedRepository.packages : []),
        ...localPackages,
      ];
    }
    const transformed = ensurePlugin(merged);
    return equal(transformed, repositorySettings) ? repository : serialize(transformed);
  },
};
