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
| 状态 | Pinia（boardStore / chamberStore / lacquerStore / stringingStore） |
| 存储 | IndexedDB（Dexie，库名 `gbguqin-db`；旧号别名与合档核对清单存 `meta`） |
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
│       ├── types/             # wood-board / sound-chamber / lacquer-layer / stringing（+ ui.ts）
│       ├── stores/            # boardStore / chamberStore / lacquerStore / stringingStore
│       ├── components/common/ # DimensionChart / LayerStack / ToneTextEditor / FilterBar / StatBadge / ProcessTimeline / EmptyPanel
│       ├── hooks/             # useGuqinFilter / useStageProgress
│       ├── pages/             # WorkshopBoard / BoardList / MergeConsole / ChamberEditor / LacquerLedger / StringingLog（+ NotFound）
│       ├── router/index.ts    # 路由表
│       └── utils/             # layer.ts / db.ts / export.ts / wood.ts / seed.ts / id.ts（+ mergeEngine.ts / renumber.ts / aliases.ts 合档）
```

## 测试

```bash
cd frontend
npm test        # vitest：逐项裁决、髹漆去重重算、故障注入/检查点重试/恢复、别名链顺延
```

## 功能与路由

| 路由 | 页面 | 说明 |
| --- | --- | --- |
| `/` | 琴坯进度 | 选材/掏膛/灰胎/上弦四阶段统计、推进比、缺失项与工序动态 |
| `/boards` | 板材登记与配对 | 面板底板配对、含水率回显、厚度差、槽腹剖面标注 |
| `/merge` | 琴号合档 | 临时琴号四类数据迁移到正式琴号，逐项裁决、核对清单与失败恢复 |
| `/chambers` | 槽腹尺寸记录 | 纳音/龙池/凤沼三处厚度、槽腹深度、天地柱与龙池凤沼尺寸，SVG 剖面标注 |
| `/lacquer` | 灰胎髹漆遍次 | 按遍次累加厚度、荫房温湿度窗口校验、层积条与养护天数 |
| `/stringing` | 上弦与音色评价 | 散音/按音/泛音三段纯文本评语、九德简述、缺陷标记与版本对照 |

## 琴号合档（临时琴号 → 正式琴号）

琴坯先用临时琴号登记，面板底板配对后改挂正式琴号；但槽腹、髹漆、上弦仍挂在旧号。「琴号合档」页完成四类旧数据迁移：

1. **先核对、不改库**：选定旧号/正式号后生成核对清单（快照存 `meta.renumberChecklists`）。两边取值不同的逐项列出，档案员必须显式裁决保留哪一边；任一冲突未裁决前禁止落库。
   - 板材：按面板/底板配对，以厚度为准整块二选一；仅一边有的整块迁入，多余板材保留改挂正式号。
   - 槽腹：纳音/龙池/凤沼厚度与槽腹深度等逐字段选边。
   - 髹漆：按遍次配对二选一、独有遍次保留；合并后按施工日期重排、重新连续编号并重算累计厚度，**任何一遍只计入一次，绝不重复累加**。
   - 上弦：散音/按音/泛音/九德等评语逐字段选边，历史评语版本两边合并去重。
2. **分阶段原子提交 + 检查点**：板材→槽腹→髹漆→上弦各一个 IndexedDB 事务，成功一类记一个检查点。
3. **失败恢复与重试**：迁移失败后可从核对清单快照逐类恢复；重试时每类先恢复快照再重放（天然幂等），且只处理尚未迁移的类别。
4. **旧号只留别名**：迁移后旧号不再是任何表的 `guqinNo`，仅存入 `meta.guqinAliases` 供搜索（评语检索、板材关键字）、随备份导出导入；链式改号时旧别名自动顺延。
5. 合档完成后，琴坯进度、各业务页、导出与评语版本一律读正式琴号。

## 数据存储说明

- 全部数据存于浏览器 IndexedDB（Dexie，库名 `gbguqin-db`），表：`boards`、`chambers`、`lacquers`、`stringings`、`meta`。
- `db.version(1)` 建表声明索引；`db.version(2).upgrade(...)` 为髹漆表增加 `[guqinNo+seq]` 复合索引并回填历史厚度。升级前可用顶栏「导出备份」导出全量 JSON。
- 首次打开且表为空时写入一批示例工序档案（`src/utils/seed.ts`）。
- 容器无状态：不使用数据库服务、不挂载命名卷，`docker compose down` 后数据仍留在浏览器中。
