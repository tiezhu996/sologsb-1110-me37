# 古琴斫制工序记录台（gbguqin）

面向斫琴师与琴坊档案员：把面板底板材、槽腹尺寸、灰胎髹漆遍次与上弦记录串成可回溯的工序档案；音色评价只用文字填写，不做音频文件与波形处理。纯前端单页应用，数据全部保存在浏览器本地，不依赖任何后端服务或外部接口。

## Docker 一键启动

```bash
cp .env.example .env
docker compose up -d --build
```

启动后访问：<http://localhost:21810>

停止并清理：

```bash
docker compose down
```

## 技术栈

| 层次 | 选型 |
| --- | --- |
| 框架 | Vue 3 + TypeScript（`<script setup>`） |
| 构建 | Vite 6（`npm run build` 含 `vue-tsc --noEmit` 类型检查） |
| UI | Element Plus 2 |
| 路由 | Vue Router 4（5 条业务路由 + 404） |
| 状态 | Pinia（boardStore / chamberStore / lacquerStore / stringingStore / aliasStore） |
| 存储 | IndexedDB（Dexie，库名 `gbguqin-db`） |
| 托管 | nginx:alpine（多阶段构建，SPA try_files + gzip） |

## 本地开发

```bash
cd frontend
npm install
npm run dev      # http://localhost:21810
npm run build    # 类型检查 + 生产构建
```

## 目录结构

```
.
├── docker-compose.yml         # 顶层 name / COMPOSE_PROJECT_NAME 容器名 / 端口映射
├── .env.example               # COMPOSE_PROJECT_NAME、FRONTEND_PORT
├── frontend/
│   ├── Dockerfile             # node:20-alpine 构建 → nginx:alpine 托管
│   ├── nginx.conf             # try_files SPA 回退 + gzip
│   ├── public/favicon.svg
│   └── src/
│       ├── types/             # wood-board / sound-chamber / lacquer-layer / stringing / guqin-alias（+ ui.ts）
│       ├── stores/            # boardStore / chamberStore / lacquerStore / stringingStore / aliasStore
│       ├── components/common/ # DimensionChart / LayerStack / ToneTextEditor / FilterBar / StatBadge / ProcessTimeline / EmptyPanel
│       ├── hooks/             # useGuqinFilter / useStageProgress
│       ├── pages/             # WorkshopBoard / BoardList / ChamberEditor / LacquerLedger / StringingLog / NumberMerge（+ NotFound）
│       ├── router/index.ts    # 路由表
│       └── utils/             # layer.ts / db.ts / export.ts / alias.ts / merge.ts / mergeRunner.ts（+ wood.ts / seed.ts / id.ts / plain.ts）
```

## 功能与路由

| 路由 | 页面 | 说明 |
| --- | --- | --- |
| `/` | 琴坯进度 | 选材/掏膛/灰胎/上弦四阶段统计、推进比、缺失项与工序动态 |
| `/boards` | 板材登记与配对 | 面板底板配对、含水率回显、厚度差、槽腹剖面标注 |
| `/chambers` | 槽腹尺寸记录 | 纳音/龙池/凤沼三处厚度、槽腹深度、天地柱与龙池凤沼尺寸，SVG 剖面标注 |
| `/lacquer` | 灰胎髹漆遍次 | 按遍次累加厚度、荫房温湿度窗口校验、层积条与养护天数 |
| `/stringing` | 上弦与音色评价 | 散音/按音/泛音三段纯文本评语、九德简述、缺陷标记与版本对照 |
| `/merge` | 琴号合档 | 临时琴号 → 正式琴号：四类旧数据逐项裁决迁移，旧号仅留可搜索别名 |

## 琴号合档规则

琴坯先用临时琴号，面板底板配对后才定正式琴号；改号往往只动了板材，槽腹、髹漆、上弦仍挂旧号，在「琴号合档」页处理：

1. 录入旧号与正式琴号后**只生成核对清单与快照**，不改任何业务库；
2. 两边不一致的**板材厚度（面板/底板）、槽腹尺寸、髹漆遍次、上弦三段评语与九德**逐项选择保留哪边；**任何一项未裁决前禁止改库**；
3. 四类数据各走独立事务迁移到正式琴号；失败的类别整体回滚并标记，可**从核对清单快照恢复**，重试时**只处理剩余类别**；
4. 髹漆按遍次配对：内容相同的重复遍自动去重，不一致的整条选边，迁移后重排序号并**按幸存遍次重算累计厚度，绝不重复累加**；
5. 上弦评语两边的历史版本按 id 合并保留，不伪造新版本；
6. 完成后旧号只作为正式琴号的**可搜索别名**（`aliases` 表）：琴坯进度、各页筛选/检索、导出与评语版本一律读正式琴号，搜旧号也能定位到正式琴号。

## 数据存储说明

- 全部数据存于浏览器 IndexedDB（Dexie，库名 `gbguqin-db`），表：`boards`、`chambers`、`lacquers`、`stringings`、`aliases`、`meta`。
- `db.version(1)` 建表声明索引；`db.version(2).upgrade(...)` 为髹漆表增加 `[guqinNo+seq]` 复合索引并回填历史厚度；`db.version(3)` 增加 `aliases` 别名表（旧号→正式琴号，多值索引 `*aliases`）。升级前可用顶栏「导出备份」导出全量 JSON（含 aliases）。
- 合档核对清单（含恢复快照）临时存于 `meta` 表，完成或丢弃后清除。
- 首次打开且表为空时写入一批示例工序档案（`src/utils/seed.ts`，含一张待合档示例琴：正式号 `Q-2506` / 临时号 `Q-LS-06`）。
- 容器无状态：不使用数据库服务、不挂载命名卷，`docker compose down` 后数据仍留在浏览器中。
- 引擎端到端校验：`cd frontend && npm run verify:merge`（fake-indexeddb，覆盖未裁决拒改、逐项选边、髹漆去重与累计重算、评语版本合并、恢复后只重试剩余项、链式改号别名不断链）。
