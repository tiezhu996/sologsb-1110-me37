import { getMeta, setMeta } from './db';

/**
 * 旧琴号别名：合档后旧号不再作为任何表的 guqinNo，只保留为可搜索别名。
 * 结构：正式琴号 -> 旧号列表（最近一次合档的旧号在前）。
 */
export type GuqinAliasMap = Record<string, string[]>;

const META_KEY = 'guqinAliases';

let cache: GuqinAliasMap | null = null;

/**
 * 别名表持久化后端：生产环境写入 Dexie meta。
 * 测试环境无 IndexedDB，可通过 setAliasSink 替换为内存实现。
 */
export interface AliasSink {
  load(): Promise<GuqinAliasMap | undefined>;
  save(map: GuqinAliasMap): Promise<void>;
}

const dexieSink: AliasSink = {
  async load() {
    const raw = await getMeta(META_KEY);
    return raw ? (JSON.parse(raw) as GuqinAliasMap) : undefined;
  },
  async save(map) {
    await setMeta(META_KEY, JSON.stringify(map));
  },
};

let sink: AliasSink = dexieSink;

/** 替换持久化后端（仅测试注入内存实现用） */
export function setAliasSink(next: AliasSink | null): void {
  sink = next ?? dexieSink;
}

/** 从持久化后端装载别名表到内存缓存（首次打开时调用一次） */
export async function loadAliases(): Promise<GuqinAliasMap> {
  cache = (await sink.load()) ?? {};
  return cache;
}

/** 直接读取缓存（无缓存时返回空表，不触发 IO；合档后由 putAliases 同步更新） */
export function getAliasesCached(): GuqinAliasMap {
  return cache ?? {};
}

/** 写入别名表（落库并更新缓存） */
export async function putAliases(map: GuqinAliasMap): Promise<void> {
  cache = map;
  await sink.save(map);
}

/** 合档提交成功后登记别名：旧号挂到正式号名下；若正式号本身是别的琴的旧号，别名链顺延 */
export async function recordAliasAfterMerge(oldNo: string, newNo: string): Promise<GuqinAliasMap> {
  const map = cache ?? (await loadAliases());
  // 深拷贝，避免原地修改污染上一次合档保存的数组
  const next: GuqinAliasMap = Object.fromEntries(
    Object.entries(map).map(([formal, aliases]) => [formal, [...aliases]]),
  );

  // 收集所有被牵连的号码：旧号可能本身已是某张琴的正式号（链式改号），
  // 此时该键名下的整组别名都要顺延到新正式号
  const removedKeys = new Set<string>();
  const chain: string[] = [];
  Object.entries(next).forEach(([formal, aliases]) => {
    if (formal === oldNo || aliases.includes(oldNo)) {
      removedKeys.add(formal);
      chain.push(formal, ...aliases);
    }
  });
  removedKeys.forEach((formal) => delete next[formal]);

  const merged = [oldNo, ...chain, ...(next[newNo] ?? [])].filter(
    (no, idx, arr) => arr.indexOf(no) === idx && no !== newNo,
  );
  if (merged.length) next[newNo] = merged;

  await putAliases(next);
  return next;
}

/** 正式琴号 -> 全部可搜索号码（含自身与旧号） */
export function searchTokens(formalNo: string): string[] {
  const map = getAliasesCached();
  return [formalNo, ...(map[formalNo] ?? [])];
}

/** 一个关键字是否命中该正式琴号或其任一旧号别名 */
export function matchesAlias(formalNo: string, keyword: string): boolean {
  const kw = keyword.trim().toLowerCase();
  if (!kw) return true;
  return searchTokens(formalNo).some((token) => token.toLowerCase().includes(kw));
}

/** 该号码是否为任何琴的旧号别名（合档选号时禁止把别名当作正式号） */
export function isAlias(no: string): boolean {
  const map = getAliasesCached();
  return Object.values(map).some((aliases) => aliases.includes(no));
}

/** 供 UI 展示：正式号 -> 别名文本 */
export function aliasLabel(formalNo: string): string {
  const aliases = getAliasesCached()[formalNo];
  return aliases?.length ? `旧号 ${aliases.join('、')}` : '';
}
