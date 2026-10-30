// dsh-ebbinghaus —— 艾宾浩斯遗忘曲线记忆插件（DeepSeek Harness）
//
// 从 QQ 桥接的 memory-db.js 里抽出来的核心模型：
//   记忆强度 S 随每次复习增长  S ← S × 1.8 × f(quality) + 0.5
//   可提取度 R 随时间衰减      R = exp(-Δt / S)   （Δt 以天计）
//   长期不用且不重要的记忆归档 R < 0.12 且 importance ≤ 2 且从未复习过
//
// 设计取舍：
// - 纯本地 SQLite（node:sqlite），无向量库、无外部服务、**不调用模型**（零 token 成本）。
// - 与 dsh-remember 互补：那个负责“从会话里提炼”，这个负责“记住的会淡忘、常用的更牢”。
// - 所有初始化/注册都包在 try 里：插件自身出错绝不能连累 dsh 的 bundle 加载。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import Schema from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';

export const name = 'dsh-ebbinghaus';
export const inject = ['tools'];

export const Config = Schema.object({
  dbPath: Schema.string().description('SQLite 文件路径。默认 ~/.dsh-ebbinghaus/memory.db'),
  sweepHours: Schema.number().default(6).description('自动归档扫描间隔（小时），0 表示关闭'),
  archiveR: Schema.number().default(0.12).description('低于这个可提取度才考虑归档'),
  archiveImportance: Schema.number().default(2).description('重要度不高于这个值才考虑归档'),
  curve: Schema.string().default('exponential')
    .description('遗忘曲线形状：exponential(默认) / power / hyperbolic / logarithmic / gaussian'),
  curveK: Schema.number().default(1.5)
    .description('曲线形状参数：power 的指数、logarithmic 的系数、gaussian 的陡度。其它曲线忽略'),
});

const DAY = 86400000;

// dsh 的工具 output 必须是 { schema, render } 这种完整 spec，不能直接给 JSON Schema。
const TEXT_OUT = {
  schema: { type: 'object', additionalProperties: true, properties: { text: { type: 'string', required: true } } },
  render: (_args, v) => [{ type: 'text', text: String(v?.text ?? '') }],
};

/**
 * 遗忘曲线族。
 *
 * 统一用 x = 闲置天数 / 强度（也就是"以强度为单位量出来的时间"）作为自变量，
 * 这样所有曲线都能共享同一个 S，切换曲线不影响"复习让记忆更牢"这件事。
 *
 *   exponential  R = exp(-x)                    经典艾宾浩斯，前期掉得快、后期趋 0
 *   power        R = (1 + x)^(-k)               幂律：早期比指数慢，尾巴很长（接近 0 但不归零）
 *   hyperbolic   R = 1 / (1 + x)                双曲：最"念旧"，一年后还有残值
 *   logarithmic  R = 1 / (1 + k·ln(1 + x))      对数：前期掉得最慢，适合"大致记得"
 *   gaussian     R = exp(-(x²)/2·k)             高斯：先平后陡，超过阈值断崖式遗忘
 *
 * k 由配置 curveK 提供（默认 1.5）；exponential / hyperbolic 不使用 k。
 */
function curveValue(x, curve, k) {
  const t = Math.max(0, Number(x) || 0);
  const kk = Math.max(0.1, Number(k) || 1.5);
  switch (String(curve || 'exponential').toLowerCase()) {
    case 'power':
      return Math.pow(1 + t, -kk);
    case 'hyperbolic':
      return 1 / (1 + t);
    case 'logarithmic':
      return 1 / (1 + kk * Math.log(1 + t));
    case 'gaussian':
      return Math.exp(-(t * t) / (2 * kk));
    case 'exponential':
    default:
      return Math.exp(-t);
  }
}

/** 可提取度 R：距上次用到现在的天数 / 强度，套用配置的曲线。 */
function retrievability(row, now, cfg) {
  const last = Number(row.last_used_at ?? row.created_at ?? now);
  const s = Math.max(0.5, Number(row.strength ?? 1));
  const days = Math.max(0, (now - last) / DAY);
  return curveValue(days / s, cfg?.curve, cfg?.curveK);
}

function initDb(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '',
      importance INTEGER NOT NULL DEFAULT 3,
      source TEXT NOT NULL DEFAULT 'dsh',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_used_at INTEGER NOT NULL,
      use_count INTEGER NOT NULL DEFAULT 0,
      strength REAL NOT NULL DEFAULT 2,
      last_review_at INTEGER,
      review_count INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_mem_archived ON memories(archived);
    CREATE INDEX IF NOT EXISTS idx_mem_used ON memories(last_used_at);
  `);
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(content, tags, content='memories', content_rowid='id', tokenize='trigram');
      CREATE TRIGGER IF NOT EXISTS mem_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, content, tags) VALUES (new.id, new.content, new.tags);
      END;
      CREATE TRIGGER IF NOT EXISTS mem_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content, tags) VALUES('delete', old.id, old.content, old.tags);
      END;
      CREATE TRIGGER IF NOT EXISTS mem_au AFTER UPDATE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content, tags) VALUES('delete', old.id, old.content, old.tags);
        INSERT INTO memories_fts(rowid, content, tags) VALUES (new.id, new.content, new.tags);
      END;
    `);
  } catch {
    /* 没有 trigram 分词器：search 会走 LIKE */
  }
  return db;
}

export function apply(ctx, config) {
  const log = (() => {
    try {
      const l = ctx.logger?.('dsh-ebbinghaus');
      return {
        info: (...a) => { try { l?.info(...a); } catch {} },
        warn: (...a) => { try { l?.warn(...a); } catch {} },
      };
    } catch { return { info: () => {}, warn: () => {} }; }
  })();

  const cfg = {
    dbPath: config?.dbPath || path.join(os.homedir(), '.dsh-ebbinghaus', 'memory.db'),
    sweepHours: Number(config?.sweepHours ?? 6),
    archiveR: Number(config?.archiveR ?? 0.12),
    archiveImportance: Number(config?.archiveImportance ?? 2),
    curve: String(config?.curve ?? 'exponential'),
    curveK: Number(config?.curveK ?? 1.5),
  };

  let db;
  try {
    db = initDb(cfg.dbPath);
  } catch (error) {
    log.warn('cannot open memory db %s: %s', cfg.dbPath, error?.message ?? error);
    return; // 打不开库就静默退出，不影响 dsh 其它部分
  }

  let fts = true;
  try { db.prepare("SELECT rowid FROM memories_fts WHERE memories_fts MATCH 'a' LIMIT 1").all(); } catch { fts = false; }
  log.info('store ready: %s', cfg.dbPath);

  const touch = (id) => {
    try { db.prepare('UPDATE memories SET use_count = use_count + 1, last_used_at = ? WHERE id = ?').run(Date.now(), id); } catch {}
  };

  const sweep = () => {
    const now = Date.now();
    let archived = 0;
    try {
      const rows = db.prepare('SELECT * FROM memories WHERE archived = 0').all();
      for (const row of rows) {
        const r = retrievability(row, now, cfg);
        if (r < cfg.archiveR && Number(row.importance) <= cfg.archiveImportance && Number(row.review_count) === 0) {
          db.prepare('UPDATE memories SET archived = 1, updated_at = ? WHERE id = ?').run(now, row.id);
          archived += 1;
        }
      }
      if (archived) log.info('sweep: archived %d', archived);
    } catch (error) {
      log.warn('sweep failed: %s', error?.message ?? error);
    }
    return archived;
  };

  if (cfg.sweepHours > 0) {
    try {
      const timer = setInterval(sweep, cfg.sweepHours * 3600000);
      timer.unref?.();
      if (typeof ctx.effect === 'function') ctx.effect(() => () => clearInterval(timer));
    } catch {}
  }

  const Agent = {
    name: 'dsh-ebbinghaus-agent',
    inject: ['tools'],
    apply(actx) {
      const register = (def) => {
        try { actx.tools.register(defineTool(def)); }
        catch (error) { log.warn('register %s failed: %s', def?.name, error?.message ?? error); }
      };

      register({
        name: 'ebb_add',
        description: '记住一条事实（艾宾浩斯记忆库）。之后可用 ebb_search 检索、ebb_review 复习加固。',
        parameters: {
          content: { type: 'string', required: true, description: '要记住的内容，一句话说清' },
          importance: { type: 'integer', description: '重要度 1-5，默认 3（越高越不容易淡忘）' },
          tags: { type: 'string', description: '逗号分隔的标签，如 用户偏好,项目' },
        },
        output: TEXT_OUT,
        isConcurrencySafe: () => true,
        async execute(args) {
          const now = Date.now();
          const importance = Math.max(1, Math.min(5, Number(args.importance) || 3));
          const strength = 1 + importance;
          const info = db.prepare(`INSERT INTO memories (content, tags, importance, created_at, updated_at, last_used_at, strength)
            VALUES (?, ?, ?, ?, ?, ?, ?)`).run(String(args.content).trim(), String(args.tags ?? ''), importance, now, now, now, strength);
          return { text: `已记住 #${Number(info.lastInsertRowid)}（重要度 ${importance}，初始强度 ${strength.toFixed(1)}）` };
        },
      });

      register({
        name: 'ebb_search',
        description: '检索艾宾浩斯记忆库，按「可提取度 × 重要度」排序。被检索到的记忆会自动续命。',
        parameters: {
          query: { type: 'string', required: true, description: '关键词，中文子串也可以' },
          limit: { type: 'integer', description: '返回条数，默认 5' },
          includeArchived: { type: 'boolean', description: '是否包含已归档的弱记忆，默认 false' },
        },
        output: TEXT_OUT,
        isConcurrencySafe: () => true,
        async execute(args) {
          const limit = Math.max(1, Math.min(20, Number(args.limit) || 5));
          const q = String(args.query ?? '').trim();
          if (!q) return { text: '（查询为空）' };
          let rows = [];
          if (fts) {
            try {
              rows = db.prepare(`SELECT m.* FROM memories_fts f JOIN memories m ON m.id = f.rowid
                WHERE memories_fts MATCH ? ORDER BY rank LIMIT ?`).all(q, limit * 4);
            } catch { rows = []; }
          }
          if (!rows.length) {
            rows = db.prepare('SELECT * FROM memories WHERE content LIKE ? OR tags LIKE ? ORDER BY id DESC LIMIT ?')
              .all(`%${q}%`, `%${q}%`, limit * 4);
          }
          const now = Date.now();
          const scored = rows
            .filter((r) => args.includeArchived || Number(r.archived) === 0)
            .map((r) => ({ ...r, R: retrievability(r, now, cfg) }))
            .map((r) => ({ ...r, score: r.R * (Number(r.importance) || 3) }))
            .sort((a, b) => b.score - a.score)
            .slice(0, limit);
          if (!scored.length) return { text: `没有匹配「${q}」的记忆。` };
          for (const row of scored) touch(row.id);
          const lines = scored.map((r) => `#${r.id} [R=${r.R.toFixed(2)} 重要度${r.importance} 复习${r.review_count}次] ${r.content}${r.tags ? ` （${r.tags}）` : ''}`);
          return { text: lines.join('\n') };
        },
      });

      register({
        name: 'ebb_review',
        description: '复习一条记忆：强度 S ← S×1.8×f(quality)+0.5，可提取度会被拉回接近 1。用于「刚确认过这条是对的」。',
        parameters: {
          id: { type: 'integer', required: true },
          quality: { type: 'integer', description: '1-5，越确信越高，默认 4' },
        },
        output: TEXT_OUT,
        isConcurrencySafe: () => true,
        async execute(args) {
          const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(Number(args.id));
          if (!row) throw new Error(`没有 id=${args.id} 的记忆`);
          const q = Math.max(1, Math.min(5, Number(args.quality) || 4));
          const factor = 0.8 + q * 0.2;
          const strength = Math.max(0.5, Number(row.strength) * 1.8 * factor + 0.5);
          const now = Date.now();
          db.prepare(`UPDATE memories SET strength = ?, review_count = review_count + 1,
            last_review_at = ?, last_used_at = ?, updated_at = ? WHERE id = ?`).run(strength, now, now, now, row.id);
          return { text: `#${row.id} 已复习：强度 ${Number(row.strength).toFixed(2)} → ${strength.toFixed(2)}，第 ${Number(row.review_count) + 1} 次` };
        },
      });

      register({
        name: 'ebb_stats',
        description: '看记忆库概况：总数、活跃、已归档、平均可提取度、即将淡忘的条数。',
        parameters: {},
        output: TEXT_OUT,
        isConcurrencySafe: () => true,
        async execute() {
          const now = Date.now();
          const rows = db.prepare('SELECT * FROM memories').all();
          const active = rows.filter((r) => !Number(r.archived));
          const rs = active.map((r) => retrievability(r, now, cfg));
          const avg = rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : 0;
          const fading = rs.filter((r) => r < 0.3).length;
          return {
            text: `共 ${rows.length} 条：活跃 ${active.length}、已归档 ${rows.length - active.length}；平均可提取度 ${avg.toFixed(2)}，其中 ${fading} 条快淡忘了。\n曲线：${cfg.curve}（k=${cfg.curveK}）\n库：${cfg.dbPath}`,
          };
        },
      });

      register({
        name: 'ebb_sweep',
        description: '立刻跑一次遗忘扫描，把「早已不用、不重要、从没复习过」的记忆归档。',
        parameters: {},
        output: TEXT_OUT,
        isConcurrencySafe: () => false,
        async execute() {
          return { text: `扫描完成：归档 ${sweep()} 条。` };
        },
      });
    },
  };

  try { ctx.plugin?.(Agent); }
  catch (error) { log.warn('mount agent failed: %s', error?.message ?? error); }
}