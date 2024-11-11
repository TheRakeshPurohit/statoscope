import type { Webpack } from '../webpack';
import { NormalizedModule, NormalizedReason } from '../types';

export const extractFileRx = /!?([^!]+)$/;
export const concatenatedIdRx = /(.+) \+ \d+ modules$/;

export function matchRxValue(rx: RegExp, string: string): string | null {
  const [, match] = string.match(rx) || [];
  return match || null;
}

const resourceNameCache = new Map<string, string>();
const nodeModuleNameCache = new Map<string, NodeModule | null>();

export function moduleNameResource(name: string | null): string | null {
  if (name) {
    const cached = resourceNameCache.get(name);

    if (cached) {
      return cached;
    }

    if (!name.includes('(ignored)') && !name.startsWith('multi')) {
      const normalized = matchRxValue(
        extractFileRx,
        name.replace('(webpack)', 'node_modules/webpack'),
      );

      if (!normalized) {
        resourceNameCache.set(name, name);
        return name;
      }

      const nameResource = matchRxValue(concatenatedIdRx, normalized) || normalized;

      if (nameResource.startsWith('./') || nameResource.startsWith('.\\')) {
        const result = nameResource.slice(2);
        resourceNameCache.set(name, result);
        return result;
      }

      resourceNameCache.set(name, nameResource);
      return nameResource;
    }
  }

  return null;
}

export function moduleResource(
  module: Webpack.RawModule | NormalizedModule | null,
): string | null {
  if (
    module?.moduleType &&
    (module?.moduleType === 'provide-module' ||
      module?.moduleType === 'consume-shared-module')
  ) {
    return module.name;
  }

  return moduleNameResource(module?.name ?? null);
}

export function moduleReasonResource(
  reason: Webpack.RawReason | NormalizedReason | null,
): string | null {
  return moduleNameResource(reason?.moduleName ?? null);
}

export type NodeModule = {
  path: string;
  name: string;
  isRoot: boolean;
};

export function nodeModule(path: string | null): NodeModule | null {
  if (!path) {
    return null;
  }

  let cached = nodeModuleNameCache.get(path);

  if (!cached) {
    const isMFModule =
      path.startsWith('consume shared module') ||
      path.startsWith('provide shared module');
    const lastNodeModulesRx = /.*node_modules[/\\](?:(@.+?)[/\\])?([^/\\]+)/;
    const [input, namespace, name] = path.match(lastNodeModulesRx) || [];
    const isRoot = input
      ? input.indexOf('node_modules') === input.lastIndexOf('node_modules')
      : false;

    cached = name
      ? <NodeModule>{
          path: isMFModule ? path : input,
          name: [namespace, name].filter(Boolean).join('/'),
          isRoot,
        }
      : null;
    nodeModuleNameCache.set(path, cached);
  }

  return cached;
}
