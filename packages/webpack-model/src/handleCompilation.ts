import md5 from 'md5';
import { API as ExtensionPackageInfoAPI } from '@statoscope/stats-extension-package-info/dist/api';
import Graph, { Node } from '@statoscope/helpers/dist/graph';
import makeIndex from '@statoscope/helpers/dist/indexer';
import type { Webpack } from '../webpack';
import {
  HandledCompilation,
  HandledFileContext,
  ModuleGraphNodeData,
  NormalizedAsset,
  NormalizedChunk,
  NormalizedCompilation,
  NormalizedEntrypoint,
  NormalizedModule,
  NormalizedReason,
  ProcessingContext,
} from '../types';
import { NormalizedFile, RawStatsFileDescriptor } from '../types';
import { moduleReasonResource, moduleResource, nodeModule } from './module';
import {
  collectRawAssets,
  collectRawChunks,
  collectRawEntrypoints,
  collectRawModules,
  collectRawModulesFromArray,
  collectRawReasonsFromArray,
} from './collector';

function getHash(
  compilation: Webpack.Compilation,
  parent?: NormalizedCompilation | null,
): string {
  if (compilation.hash) {
    return compilation.hash;
  }

  if (parent) {
    return md5(parent.hash + String(compilation.name));
  }

  return md5(compilation.name || 'unknown');
}

export default function handleCompilations(
  rawStatsFileDescriptor: RawStatsFileDescriptor,
  file: NormalizedFile,
  fileContext: HandledFileContext,
): HandledCompilation[] {
  const compilations: HandledCompilation[] = [];

  type StackItem = {
    compilation: Webpack.Compilation;
    parent: NormalizedCompilation | null;
  };
  const stack: StackItem[] = [
    {
      compilation: rawStatsFileDescriptor.data,
      parent: null,
    },
  ];
  let cursor: StackItem | undefined;

  while ((cursor = stack.pop())) {
    const handled = handleCompilation(
      cursor.compilation,
      file,
      cursor.parent,
      fileContext,
    );

    if (cursor.parent) {
      cursor.parent.children.push(handled.data);
    }

    file.compilations.push(handled.data);
    compilations.push(handled);

    for (const child of cursor.compilation.children || []) {
      stack.push({ compilation: child, parent: handled.data });
    }
  }

  return compilations;
}

function buildGraph(compilation: NormalizedCompilation): {
  module: Graph<ModuleGraphNodeData>;
} {
  const moduleGraph = new Graph<ModuleGraphNodeData>();
  const globalHandled = new Set<NormalizedModule>();

  for (const entry of compilation.entrypoints) {
    if (entry.data.dep?.module) {
      handleModuleNode(moduleGraph, entry.data.dep.module);
    }
  }

  return {
    module: moduleGraph,
  };

  function handleModuleNode(
    graph: Graph<ModuleGraphNodeData>,
    module: NormalizedModule,
  ): Node<ModuleGraphNodeData> {
    if (globalHandled.has(module)) {
      return graph.getNode(module.identifier)!;
    }

    globalHandled.add(module);

    const entries = module.reasons
      .filter((r) => r.resolvedEntry)
      .map((r) => r.resolvedEntry!);
    const node =
      graph.getNode(module.identifier) ??
      graph.makeNode(module.identifier, { module, entries });
    const handled = new WeakSet<NormalizedModule>();

    for (const innerModule of module.modules) {
      handled.add(innerModule);
      node.addChild(handleModuleNode(graph, innerModule));
    }

    for (const dep of module.deps ?? []) {
      if (handled.has(dep.module)) {
        continue;
      }

      handled.add(dep.module);
      node.addChild(handleModuleNode(graph, dep.module));
    }

    return node;
  }
}

function moduleIdModifier(id: string): string {
  let cached = moduleIdModifier.cache.get(id);

  if (!cached) {
    cached = id.replace(/(.+[|\s])([a-f0-9]+)$/, '$1root');
    moduleIdModifier.cache.set(id, cached);
  }

  return cached;
}
moduleIdModifier.cache = new Map<string, string>();

function handleCompilation(
  compilation: Webpack.Compilation,
  file: NormalizedFile,
  parent: NormalizedCompilation | null,
  fileContext: HandledFileContext,
): HandledCompilation {
  const normalized: NormalizedCompilation = {
    time: compilation.time,
    builtAt: compilation.builtAt,
    name: compilation.name,
    hash: getHash(compilation, parent),
    entrypoints: [],
    chunks: [],
    assets: [],
    modules: [],
    nodeModules: [],
    children: [],
    isChild: !!parent?.hash,
    parent: parent?.hash || null,
  };
  const indexes: ProcessingContext['indexes'] = {
    assets: makeIndex((item) => item.name),
    chunks: makeIndex((item) => item.id),
    entrypoints: makeIndex((item) => item.name),
    modules: makeIndex((item) => item.identifier, null, {
      idModifier: moduleIdModifier,
    }),
    packages: makeIndex((item) => item.name),
  };
  const rawIndexes: ProcessingContext['rawIndexes'] = {
    assets: makeIndex((item) => item.name),
    chunks: makeIndex((item) => item.id),
    entrypoints: makeIndex((item) => item.name),
    modules: makeIndex((item) => item.identifier, null, {
      idModifier: moduleIdModifier,
    }),
  };
  const resolvers: ProcessingContext['resolvers'] = {
    resolveAsset: (id) => indexes.assets.get(id),
    resolveChunk: (id) => indexes.chunks.get(id),
    resolveEntrypoint: (id) => indexes.entrypoints.get(id),
    resolvePackage: (id) => indexes.packages.get(id),
    resolveModule: (id) => indexes.modules.get(id),
  };
  const processingContext: ProcessingContext = {
    fileContext,
    indexes,
    rawIndexes,
    resolvers,
  };

  for (const module of collectRawModules(compilation)) {
    processingContext.rawIndexes.modules.add(module);
  }
  for (const chunk of collectRawChunks(compilation)) {
    processingContext.rawIndexes.chunks.add(chunk);
  }
  for (const asset of collectRawAssets(compilation)) {
    processingContext.rawIndexes.assets.add(asset);
  }
  for (const entrypoint of collectRawEntrypoints(compilation)) {
    processingContext.rawIndexes.entrypoints.add(entrypoint);
  }

  prepareEntries(compilation, processingContext);
  prepareModules(processingContext);
  prepareChunks(processingContext);
  linkChunks(processingContext);
  prepareAssets(processingContext);
  extractPackages(normalized as unknown as Webpack.Compilation, processingContext);

  for (const module of processingContext.indexes.modules.getAll()) {
    normalized.modules.push(module);
    processingContext.fileContext.indexes.compilation.byModule.set(module, normalized);
  }
  for (const chunk of processingContext.indexes.chunks.getAll()) {
    normalized.chunks.push(chunk);
    processingContext.fileContext.indexes.compilation.byChunks.set(chunk, normalized);
  }
  for (const asset of processingContext.indexes.assets.getAll()) {
    normalized.assets.push(asset);
    processingContext.fileContext.indexes.compilation.byAsset.set(asset, normalized);
  }
  for (const entry of processingContext.indexes.entrypoints.getAll()) {
    normalized.entrypoints.push(entry);
    processingContext.fileContext.indexes.compilation.byEntrypoint.set(entry, normalized);
  }

  const graph = buildGraph(normalized);

  return {
    data: normalized,
    resolvers,
    indexes: processingContext.indexes,
    graph: {
      module: graph.module,
    },
    file,
  };
}

function mergeModules(
  from: Webpack.RawModule,
  to: NormalizedModule,
  context: ProcessingContext,
): void {
  const chunks = new Set(
    [...(to.chunks ?? []), ...(from.chunks ?? [])].reduce<NormalizedChunk[]>((acc, c) => {
      const id = typeof c === 'string' || typeof c === 'number' ? c : c.id;
      const chunk = context.rawIndexes.chunks.get(id) as NormalizedChunk | null;

      if (chunk) {
        acc.push(chunk);
      }

      return acc;
    }, []),
  );
  const toReasons = collectRawReasonsFromArray(to.reasons);
  const fromReasons = collectRawReasonsFromArray(from.reasons ?? []);
  const reasonMap = new Map<string, NormalizedReason>();

  to.chunks = [...chunks];

  for (const current of [...toReasons.values(), ...fromReasons.values()]) {
    const key = `${current.moduleIdentifier}-${current.type}-${current.loc}`;

    if (!reasonMap.has(key)) {
      reasonMap.set(key, current as NormalizedReason);
    }
  }

  to.reasons = [...reasonMap.values()];
}

function prepareModule(module: Webpack.RawModule, context: ProcessingContext): void {
  if (context.indexes.modules.hasId(module.identifier)) {
    return;
  }

  const existingModule = context.indexes.modules.get(module.identifier);
  const normalizedModule = module as unknown as NormalizedModule;

  context.indexes.modules.add(normalizedModule);

  normalizedModule.resolvedResource = moduleResource(module);

  if (module.issuerPath) {
    normalizedModule.issuerPath.map(
      (i) =>
        (i.resolvedModule = context.rawIndexes.modules.get(
          i.identifier,
        ) as NormalizedModule | null),
    );
  } else {
    module.issuerPath = [];
  }

  if (module.chunks) {
    normalizedModule.chunks = module.chunks
      .map((c) => resolveRawChunk(c, context))
      .filter(Boolean) as NormalizedChunk[];
  } else {
    module.chunks = [];
  }

  if (module.reasons) {
    const reasons = collectRawReasonsFromArray(module.reasons!);
    let newReasons = [];

    for (const item of reasons.values()) {
      newReasons.push(item);
    }

    newReasons = newReasons.filter((r) => r.moduleIdentifier !== module.identifier);
    for (const reason of newReasons) {
      const normalizedReason = normalizeReason(reason, context);
      const resolvedModule = normalizedReason.resolvedModule;
      const resolvedEntry = normalizedReason.resolvedEntry;

      if (resolvedModule) {
        resolvedModule.deps ??= [];
        resolvedModule.deps.push({
          type: 'module',
          module: normalizedModule,
          reason: normalizedReason,
        });
      }

      if (resolvedEntry) {
        resolvedEntry.data.dep = {
          type: 'module',
          module: normalizedReason.resolvedModule ?? normalizedModule,
          reason: normalizedReason,
        };
      }
    }

    module.reasons = newReasons;
  } else {
    module.reasons = [];
  }

  if (existingModule) {
    mergeModules(module, existingModule, context);
  }

  (module as Webpack.RawModule).modules ??= [];

  const innerModules = collectRawModulesFromArray(module.modules!);
  const newInnerModules = [];

  for (const item of innerModules.values()) {
    const innerModule = context.rawIndexes.modules.get(item.identifier)!;

    newInnerModules.push(innerModule);
    innerModule.chunks ??= [];

    if (!innerModule.chunks.length) {
      innerModule.chunks = module.chunks;

      for (const chunk of module.chunks) {
        (<Webpack.Chunk>chunk).modules ??= [];
        (<Webpack.Chunk>chunk).modules!.push(innerModule);
      }
    }
  }

  module.modules = newInnerModules;
}

function normalizeReason(
  reason: Webpack.RawReason,
  context: ProcessingContext,
): NormalizedReason {
  const normalizedReason = reason as unknown as NormalizedReason;

  normalizedReason.resolvedModule = reason.moduleIdentifier
    ? (context.rawIndexes.modules.get(reason.moduleIdentifier) as NormalizedModule | null)
    : null;

  if (/(?:.+ )?entry$/.test(reason.type ?? '')) {
    if (reason.loc) {
      let resolvedName = reason.loc;
      let resolved = context.indexes.entrypoints.get(resolvedName);

      if (!resolved) {
        // handle foo[0] for webpack 4 single entry
        resolvedName = reason.loc.slice(0, -3);
        resolved = context.indexes.entrypoints.get(resolvedName);
      }

      if (resolved) {
        normalizedReason.resolvedEntryName = resolvedName;
        normalizedReason.resolvedEntry = resolved;
      }
    }
  }

  return normalizedReason;
}

function prepareModules(context: ProcessingContext): void {
  for (const module of context.rawIndexes.modules.getAll()) {
    prepareModule(module, context);
  }
}

function resolveRawChunk(
  chunk: Webpack.Chunk | Webpack.ChunkID,
  context: ProcessingContext,
): Webpack.Chunk | null {
  if (chunk === null) {
    return null;
  }

  return context.rawIndexes.chunks.get(
    typeof chunk === 'string' || typeof chunk === 'number' ? chunk : chunk.id,
  );
}

function prepareChunk(chunk: Webpack.Chunk | null, context: ProcessingContext): void {
  if (chunk == null) {
    return;
  }

  if (context.indexes.chunks.hasId(chunk.id)) {
    return;
  }

  const normalizedChunk = chunk as unknown as NormalizedChunk;

  context.indexes.chunks.add(normalizedChunk);

  if (chunk.modules) {
    chunk.modules = [...context.indexes.modules.getAll()].filter((m) =>
      m.chunks.find((c) => c.id === chunk.id),
    ) as Webpack.Module[];
  } else {
    chunk.modules = [];
  }

  if (chunk.files) {
    normalizedChunk.files = chunk.files
      .filter(Boolean) // to skip null files, issue #158
      .map((f) => context.rawIndexes.assets.get(typeof f === 'string' ? f : f.name))
      .filter(Boolean) as NormalizedAsset[];
  } else {
    chunk.files = [];
  }

  if (chunk.sizes) {
    const keys = Object.keys(chunk.sizes);
    if (keys.length === 1 && keys[0] === 'runtime') {
      (<NormalizedChunk>chunk).isRuntime = true;
    }
  }

  if (chunk.children) {
    chunk.children.forEach((c) => resolveRawChunk(c, context));

    for (const children of chunk.children) {
      prepareChunk(resolveRawChunk(children, context), context);
    }
  }

  chunk.children = [];

  if (chunk.siblings) {
    normalizedChunk.siblings = chunk.siblings
      .map((c) => resolveRawChunk(c, context))
      .filter(Boolean) as NormalizedChunk[];

    for (const sibling of chunk.siblings) {
      prepareChunk(resolveRawChunk(sibling, context), context);
    }
  } else {
    chunk.siblings = [];
  }

  if (chunk.parents) {
    chunk.parents.forEach((c) => resolveRawChunk(c, context));

    for (const parent of chunk.parents) {
      prepareChunk(resolveRawChunk(parent, context), context);
    }
  }

  chunk.parents = [];

  if (chunk.origins) {
    const origins = [...collectRawReasonsFromArray(chunk.origins).values()];

    origins.forEach((o) => {
      if (!o.moduleIdentifier) {
        (o as NormalizedReason).resolvedEntryName = o.loc;
        (o as NormalizedReason).resolvedEntry =
          context.indexes.entrypoints.get(o.loc!) ?? null;
      }
      (o as NormalizedReason).resolvedModule = o.moduleIdentifier
        ? (context.rawIndexes.modules.get(o.moduleIdentifier) as NormalizedModule)
        : null;
    });
    chunk.origins = origins;
  } else {
    chunk.origins = [];
  }
}

function prepareChunks(context: ProcessingContext): void {
  for (const chunk of context.rawIndexes.chunks.getAll()) {
    prepareChunk(chunk, context);
  }
}

function getChunkMapItem(
  map: Map<
    NormalizedChunk,
    { children: Set<NormalizedChunk>; parents: Set<NormalizedChunk> }
  >,
  chunk: NormalizedChunk,
): { children: Set<NormalizedChunk>; parents: Set<NormalizedChunk> } {
  let mapItem = map.get(chunk);
  if (!mapItem) {
    mapItem = {
      children: new Set(),
      parents: new Set(),
    };
    map.set(chunk, mapItem);
  }
  return mapItem;
}

function linkChunks(context: ProcessingContext): void {
  const map = new Map<
    NormalizedChunk,
    { children: Set<NormalizedChunk>; parents: Set<NormalizedChunk> }
  >();
  top: for (const childChunk of context.indexes.chunks.getAll()) {
    const childMapItem = getChunkMapItem(map, childChunk);

    for (const origin of childChunk.origins as NormalizedReason[]) {
      let targetModule = origin.resolvedModule ?? null;

      if (!targetModule && origin.resolvedEntry) {
        targetModule = origin.resolvedEntry.data.dep?.module ?? null;
      }

      if (targetModule?.chunks.includes(childChunk)) {
        continue top;
      }

      for (const parentChunk of targetModule?.chunks ?? []) {
        const parentMapItem = getChunkMapItem(map, parentChunk);

        if (parentChunk !== childChunk) {
          parentMapItem.children.add(childChunk);
          childMapItem.parents.add(parentChunk);
        }
      }
    }
  }

  for (const [chunk, data] of map) {
    chunk.children = [...data.children];
    chunk.parents = [...data.parents];
  }
}

function prepareAssets(context: ProcessingContext): void {
  for (const asset of context.rawIndexes.assets.getAll()) {
    const normalizedAsset = asset as unknown as NormalizedAsset;

    context.indexes.assets.add(normalizedAsset);

    if (asset.chunks) {
      asset.chunks = asset.chunks
        .map((c) => resolveRawChunk(c, context))
        .filter(Boolean) as Webpack.Chunk[];
    } else {
      asset.chunks = [];
    }

    asset.files ??= [];
  }
}

function prepareEntries(
  compilation: Webpack.Compilation,
  context: ProcessingContext,
): void {
  for (const name in compilation.entrypoints) {
    const entry = compilation.entrypoints[name];

    if (entry.chunks) {
      entry.chunks = entry.chunks
        .map((c) => resolveRawChunk(c, context))
        .filter(Boolean) as Webpack.Chunk[];
    }

    if (entry.assets) {
      entry.assets = entry.assets
        .map(
          (a) =>
            context.rawIndexes.assets.get(
              typeof a === 'string' ? a : a.name,
            ) as Webpack.RawAsset,
        )
        .filter(Boolean);
    }

    context.indexes.entrypoints.add({ name, data: entry as NormalizedEntrypoint });
  }
}

export function extractPackages(
  compilation: Webpack.Compilation,
  context: ProcessingContext,
): void {
  const extractModulePackages = (module: Webpack.RawModule): void => {
    const resource = moduleResource(module);

    if (!resource) {
      return;
    }

    const modulePackage = nodeModule(resource);

    if (modulePackage) {
      let resolvedPackage = context.indexes.packages.get(modulePackage.name);

      if (!resolvedPackage) {
        resolvedPackage = { name: modulePackage.name, instances: [] };
        context.indexes.packages.add(resolvedPackage);
      }

      let instance = resolvedPackage.instances.find(
        ({ path }) => path === modulePackage.path,
      );

      if (!instance) {
        const packageInfoExt = context.fileContext.resolvers.resolveExtension(
          '@statoscope/stats-extension-package-info',
        );
        const api = packageInfoExt?.api as ExtensionPackageInfoAPI | undefined;

        const extInstance =
          api?.getInstance(compilation.hash!, resolvedPackage.name, modulePackage.path) ??
          null;

        instance = {
          path: modulePackage.path,
          isRoot: modulePackage.isRoot,
          reasons: [],
          modules: [module as NormalizedModule],
          version: extInstance?.info.version,
        };
        resolvedPackage.instances.push(instance);
      } else {
        if (!instance.modules.includes(module as NormalizedModule)) {
          instance.modules.push(module as NormalizedModule);
        }
      }

      const instanceReasonsKeys = new Set(instance.reasons.map((r) => r.data.identifier));

      // reasons already ungrouped and normalized
      const reasons = module.reasons as NormalizedReason[];

      for (const reason of reasons ?? []) {
        const reasonPackage = nodeModule(moduleReasonResource(reason));

        if (reasonPackage && reasonPackage.path === instance.path) {
          continue;
        }

        const reasonType = 'module';
        const reasonKey = reason.moduleIdentifier ?? 'unknown';

        if (!instanceReasonsKeys.has(reasonKey) && reason.resolvedModule) {
          instance.reasons.push({
            type: reasonType,
            data: reason.resolvedModule,
          });
          instanceReasonsKeys.add(reasonKey);
        }
      }
    }
  };

  for (const module of context.rawIndexes.modules.getAll()) {
    extractModulePackages(module);
  }

  for (const packageItem of context.indexes.packages.getAll()) {
    (compilation as unknown as NormalizedCompilation).nodeModules.push(packageItem);
  }
}
